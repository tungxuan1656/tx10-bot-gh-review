import { access, cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isReviewableFilePath } from "./filter-files.js";
import type { AppLogger } from "../logger.js";
import type { PRInfoObject, PullRequestContext, ReviewableFile } from "./types.js";

const baseRefName = "refs/codex-review/base";
const headRefName = "refs/codex-review/head";

/** Maximum characters of the combined diff before truncation. */
const maxDiffChars = 80_000;

export type PreparedReviewWorkspace = {
  cleanup(): Promise<void>;
  diff: string;
  prInfo: PRInfoObject;
  reviewableFiles: ReviewableFile[];
  workingDirectory: string;
};

export type ReviewWorkspaceManager = {
  prepareWorkspace(
    context: PullRequestContext,
    prInfo: PRInfoObject,
    loggerOverride?: AppLogger,
  ): Promise<PreparedReviewWorkspace>;
};

type CreateTemporaryReviewWorkspaceManagerInput = {
  gitBin?: string;
  githubToken: string;
  logger: AppLogger;
  timeoutMs?: number;
};

type ChangedFile = {
  path: string;
  status: string;
};

const reviewSkillsRelativePath = path.join("resources", "review-skills");
const currentFilePath = fileURLToPath(import.meta.url);

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveProjectRootFrom(startPath: string): Promise<string> {
  let currentPath = path.dirname(startPath);

  while (true) {
    if (await pathExists(path.join(currentPath, reviewSkillsRelativePath))) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(
        `Could not resolve project root containing ${reviewSkillsRelativePath} from ${startPath}.`,
      );
    }

    currentPath = parentPath;
  }
}

async function copyReviewSkillsToWorkspace(workingDirectory: string): Promise<void> {
  const projectRoot = await resolveProjectRootFrom(currentFilePath);
  const sourceSkillsDirectory = path.join(projectRoot, reviewSkillsRelativePath);
  const destinationSkillsDirectory = path.join(workingDirectory, ".agents", "skills");
  const skillEntries = await readdir(sourceSkillsDirectory, { withFileTypes: true });

  await mkdir(destinationSkillsDirectory, { recursive: true });

  await Promise.all(
    skillEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        cp(
          path.join(sourceSkillsDirectory, entry.name),
          path.join(destinationSkillsDirectory, entry.name),
          {
            force: true,
            recursive: true,
          },
        ),
      ),
  );
}

/**
 * Serialize a PRInfoObject to a simple YAML string (no external deps).
 */
function serializePRInfoToYaml(prInfo: PRInfoObject): string {
  function escapeYamlString(value: string): string {
    // Use literal block scalar for multi-line, double-quoted for single-line
    if (value.includes("\n")) {
      const indented = value.replace(/\n/g, "\n  ");
      return `|-\n  ${indented}`;
    }
    // Escape double quotes and wrap in double quotes
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  const lines: string[] = [
    `owner: ${escapeYamlString(prInfo.owner)}`,
    `repo: ${escapeYamlString(prInfo.repo)}`,
    `pull_number: ${prInfo.pullNumber}`,
    `title: ${escapeYamlString(prInfo.title)}`,
    `html_url: ${escapeYamlString(prInfo.htmlUrl)}`,
    `head_sha: ${escapeYamlString(prInfo.headSha)}`,
    `base_sha: ${escapeYamlString(prInfo.baseSha)}`,
    `head_ref: ${escapeYamlString(prInfo.headRef)}`,
    `base_ref: ${escapeYamlString(prInfo.baseRef)}`,
    `description: ${escapeYamlString(prInfo.description || "(none)")}`,
    ``,
    `commits:`,
  ];

  for (const commit of prInfo.commits) {
    lines.push(`  - sha: ${escapeYamlString(commit.sha)}`);
    lines.push(`    message: ${escapeYamlString(commit.message)}`);
  }

  lines.push(``);
  lines.push(`changed_files:`);
  for (const filePath of prInfo.changedFilePaths) {
    lines.push(`  - ${escapeYamlString(filePath)}`);
  }

  return lines.join("\n") + "\n";
}

function truncateDiff(diff: string): string {
  if (diff.length <= maxDiffChars) {
    return diff;
  }
  return `${diff.slice(0, maxDiffChars)}\n...[diff truncated]`;
}

function isRenameOrCopy(status: string): boolean {
  return status.startsWith("R") || status.startsWith("C");
}

function buildAuthenticatedRemoteUrl(cloneUrl: string, githubToken: string): string {
  if (!/^https?:\/\//.test(cloneUrl)) {
    return cloneUrl;
  }

  const url = new URL(cloneUrl);
  url.username = "x-access-token";
  url.password = githubToken;
  return url.toString();
}

function parseChangedFiles(rawOutput: string): ChangedFile[] {
  const entries = rawOutput.split("\0").filter((entry) => entry.length > 0);
  const changedFiles: ChangedFile[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const status = entries[index];

    if (!status) {
      continue;
    }

    if (isRenameOrCopy(status)) {
      const nextPath = entries[index + 2];
      if (nextPath) {
        changedFiles.push({
          path: nextPath,
          status,
        });
      }
      index += 2;
      continue;
    }

    const nextPath = entries[index + 1];
    if (nextPath) {
      changedFiles.push({
        path: nextPath,
        status,
      });
    }
    index += 1;
  }

  return changedFiles;
}

function isRemovedStatus(status: string): boolean {
  return status.startsWith("D");
}

function isReviewableChangedFile(file: ChangedFile): boolean {
  return !isRemovedStatus(file.status) && isReviewableFilePath(file.path);
}

function createWorkspaceCleanup(workingDirectory: string): () => Promise<void> {
  let cleanedUp = false;

  return async () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    await rm(workingDirectory, { force: true, recursive: true });
  };
}

function redactCommandOutput(text: string, redactions: string[]): string {
  let sanitized = text;

  for (const redaction of redactions) {
    if (!redaction) {
      continue;
    }

    sanitized = sanitized.split(redaction).join("***");
  }

  return sanitized.replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
}

async function runCommand(input: {
  args: string[];
  bin: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  redactions?: string[];
  timeoutMs: number;
}): Promise<string> {
  const child = spawn(input.bin, input.args, {
    cwd: input.cwd,
    env: {
      ...process.env,
      ...input.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, input.timeoutMs);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => {
    clearTimeout(timeout);
  });

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = redactCommandOutput(
    Buffer.concat(stderrChunks).toString("utf8").trim(),
    input.redactions ?? [],
  );
  const commandLabel = `${input.bin} ${input.args[0] ?? ""}`.trim();

  if (timedOut) {
    throw new Error(`Command timed out: ${commandLabel}`);
  }

  if (exitCode !== 0) {
    throw new Error(stderr || `Command failed: ${commandLabel}`);
  }

  return stdout;
}

async function fetchRevision(input: {
  cwd: string;
  gitBin: string;
  remote: string;
  revision: string;
  fallbackRef: string;
  localRef: string;
  redactions: string[];
  timeoutMs: number;
}): Promise<void> {
  const env = {
    GIT_TERMINAL_PROMPT: "0",
  };

  try {
    await runCommand({
      args: [
        "fetch",
        "--no-tags",
        "--depth=1",
        input.remote,
        `+${input.revision}:${input.localRef}`,
      ],
      bin: input.gitBin,
      cwd: input.cwd,
      env,
      redactions: input.redactions,
      timeoutMs: input.timeoutMs,
    });
  } catch {
    await runCommand({
      args: [
        "fetch",
        "--no-tags",
        input.remote,
        `+refs/heads/${input.fallbackRef}:${input.localRef}`,
      ],
      bin: input.gitBin,
      cwd: input.cwd,
      env,
      redactions: input.redactions,
      timeoutMs: input.timeoutMs,
    });
  }

  const resolvedRevision = (await runCommand({
    args: ["rev-parse", input.localRef],
    bin: input.gitBin,
    cwd: input.cwd,
    redactions: input.redactions,
    timeoutMs: input.timeoutMs,
  })).trim();

  if (resolvedRevision !== input.revision) {
    throw new Error(
      `Fetched ${input.localRef} at ${resolvedRevision}, expected ${input.revision}.`,
    );
  }
}

export function createTemporaryReviewWorkspaceManager(
  input: CreateTemporaryReviewWorkspaceManagerInput,
): ReviewWorkspaceManager {
  const gitBin = input.gitBin ?? "git";
  const timeoutMs = input.timeoutMs ?? 60_000;
  const commandRedactions = [input.githubToken, encodeURIComponent(input.githubToken)];

  return {
    async prepareWorkspace(
      context: PullRequestContext,
      prInfo: PRInfoObject,
      loggerOverride?: AppLogger,
    ): Promise<PreparedReviewWorkspace> {
      const logger = loggerOverride ?? input.logger;
      const startedAt = Date.now();
      const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-review-workspace-"));
      const cleanup = createWorkspaceCleanup(workingDirectory);

      try {
        logger.info(
          {
            component: "workspace",
            event: "workspace.prepare_started",
            headSha: context.headSha,
            status: "started",
          },
          "Workspace prepare started",
        );

        await runCommand({
          args: ["init"],
          bin: gitBin,
          cwd: workingDirectory,
          redactions: commandRedactions,
          timeoutMs,
        });

        const baseRemoteUrl = buildAuthenticatedRemoteUrl(context.baseCloneUrl, input.githubToken);
        const headRemoteUrl = buildAuthenticatedRemoteUrl(context.headCloneUrl, input.githubToken);

        await runCommand({
          args: ["remote", "add", "origin", baseRemoteUrl],
          bin: gitBin,
          cwd: workingDirectory,
          redactions: commandRedactions,
          timeoutMs,
        });

        const headRemoteName = headRemoteUrl === baseRemoteUrl ? "origin" : "head";
        if (headRemoteName === "head") {
          await runCommand({
            args: ["remote", "add", "head", headRemoteUrl],
            bin: gitBin,
            cwd: workingDirectory,
            redactions: commandRedactions,
            timeoutMs,
          });
        }

        await fetchRevision({
          cwd: workingDirectory,
          fallbackRef: context.baseRef,
          gitBin,
          localRef: baseRefName,
          remote: "origin",
          redactions: commandRedactions,
          revision: context.baseSha,
          timeoutMs,
        });
        await fetchRevision({
          cwd: workingDirectory,
          fallbackRef: context.headRef,
          gitBin,
          localRef: headRefName,
          remote: headRemoteName,
          redactions: commandRedactions,
          revision: context.headSha,
          timeoutMs,
        });

        await runCommand({
          args: ["checkout", "--detach", headRefName],
          bin: gitBin,
          cwd: workingDirectory,
          redactions: commandRedactions,
          timeoutMs,
        });

        await copyReviewSkillsToWorkspace(workingDirectory);

        // Write pr-info.yaml into workspace root for Codex to read
        const prInfoYaml = serializePRInfoToYaml(prInfo);
        await writeFile(path.join(workingDirectory, "pr-info.yaml"), prInfoYaml, "utf8");

        const changedFiles = parseChangedFiles(
          await runCommand({
            args: ["diff", "--name-status", "-z", baseRefName, headRefName],
            bin: gitBin,
            cwd: workingDirectory,
            redactions: commandRedactions,
            timeoutMs,
          }),
        ).filter(isReviewableChangedFile);

        const reviewableFiles = (
          await Promise.all(
            changedFiles.map(async (file) => {
              const patch = await runCommand({
                args: ["diff", "--unified=5", baseRefName, headRefName, "--", file.path],
                bin: gitBin,
                cwd: workingDirectory,
                redactions: commandRedactions,
                timeoutMs,
              });

              if (!patch.trim()) {
                return null;
              }

              const content = await runCommand({
                args: ["show", `${headRefName}:${file.path}`],
                bin: gitBin,
                cwd: workingDirectory,
                redactions: commandRedactions,
                timeoutMs,
              });

              return {
                content,
                path: file.path,
                patch,
              } satisfies ReviewableFile;
            }),
          )
        ).filter((file): file is ReviewableFile => file !== null);

        const rawDiff =
          reviewableFiles.length === 0
            ? ""
            : await runCommand({
                args: [
                  "diff",
                  "--unified=5",
                  baseRefName,
                  headRefName,
                  "--",
                  ...reviewableFiles.map((file) => file.path),
                ],
                bin: gitBin,
                cwd: workingDirectory,
                redactions: commandRedactions,
                timeoutMs,
              });

        const diff = truncateDiff(rawDiff);

        logger.info(
          {
            component: "workspace",
            diffChars: diff.length,
            diffTruncated: rawDiff.length > maxDiffChars,
            durationMs: Date.now() - startedAt,
            event: "workspace.prepare_completed",
            reviewableFileCount: reviewableFiles.length,
            status: "completed",
          },
          "Workspace prepare completed",
        );

        return {
          cleanup,
          diff,
          prInfo,
          reviewableFiles,
          workingDirectory,
        };
      } catch (error) {
        logger.error(
          {
            component: "workspace",
            error,
            event: "workspace.prepare_failed",
            status: "failed",
          },
          "Workspace prepare failed",
        );
        await cleanup();
        throw error;
      }
    },
  };
}
