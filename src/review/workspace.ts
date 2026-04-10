import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { isReviewableFilePath } from "./filter-files.js";
import type { AppLogger } from "../logger.js";
import type { PullRequestContext, ReviewableFile } from "./types.js";

const baseRefName = "refs/codex-review/base";
const headRefName = "refs/codex-review/head";

export type PreparedReviewWorkspace = {
  cleanup(): Promise<void>;
  diff: string;
  reviewableFiles: ReviewableFile[];
  workingDirectory: string;
};

export type ReviewWorkspaceManager = {
  prepareWorkspace(
    context: PullRequestContext,
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

        const diff =
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

        logger.info(
          {
            component: "workspace",
            diffChars: diff.length,
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
