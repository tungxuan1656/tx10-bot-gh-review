import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTemporaryReviewWorkspaceManager } from "../src/review/workspace.js";
import type { PullRequestContext } from "../src/review/types.js";

const createdDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function runGit(args: string[], cwd: string): Promise<string> {
  const child = spawn("git", args, {
    cwd,
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

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(Buffer.concat(stderrChunks).toString("utf8").trim());
  }

  return Buffer.concat(stdoutChunks).toString("utf8").trim();
}

async function createRemoteRepository(): Promise<{
  baseSha: string;
  headSha: string;
  remotePath: string;
}> {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "workspace-manager-test-"));
  createdDirectories.push(rootDirectory);

  const sourcePath = path.join(rootDirectory, "source");
  const remotePath = path.join(rootDirectory, "remote.git");

  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await runGit(["init", "--initial-branch=main"], sourcePath);
  await runGit(["config", "user.email", "review-bot@example.com"], sourcePath);
  await runGit(["config", "user.name", "Review Bot"], sourcePath);

  await writeFile(path.join(sourcePath, "src/app.ts"), "export const value = 'base';\n", "utf8");
  await writeFile(path.join(sourcePath, "README.md"), "# Base\n", "utf8");
  await runGit(["add", "src/app.ts", "README.md"], sourcePath);
  await runGit(["commit", "-m", "base"], sourcePath);
  const baseSha = await runGit(["rev-parse", "HEAD"], sourcePath);

  await writeFile(path.join(sourcePath, "src/app.ts"), "export const value = 'head';\n", "utf8");
  await writeFile(path.join(sourcePath, "README.md"), "# Head\n", "utf8");
  await runGit(["add", "src/app.ts", "README.md"], sourcePath);
  await runGit(["commit", "-m", "head"], sourcePath);
  const headSha = await runGit(["rev-parse", "HEAD"], sourcePath);

  await runGit(["clone", "--bare", sourcePath, remotePath], rootDirectory);

  return {
    baseSha,
    headSha,
    remotePath,
  };
}

function createPullRequestContext(input: {
  baseSha: string;
  headSha: string;
  remotePath: string;
}): PullRequestContext {
  return {
    action: "review_requested",
    installationId: 0,
    owner: "acme",
    repo: "repo",
    pullNumber: 42,
    title: "Example",
    htmlUrl: "https://github.com/acme/repo/pull/42",
    headSha: input.headSha,
    headRef: "main",
    headCloneUrl: input.remotePath,
    baseSha: input.baseSha,
    baseRef: "main",
    baseCloneUrl: input.remotePath,
  };
}

describe("createTemporaryReviewWorkspaceManager", () => {
  it("materializes the PR repository into a temporary workspace and returns reviewable files", async () => {
    const repo = await createRemoteRepository();
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const manager = createTemporaryReviewWorkspaceManager({
      githubToken: "unused",
      logger: logger as never,
      timeoutMs: 10_000,
    });

    const workspace = await manager.prepareWorkspace(createPullRequestContext(repo));

    try {
      expect(workspace.workingDirectory).toContain("codex-review-workspace-");
      expect(workspace.reviewableFiles).toHaveLength(1);
      expect(workspace.reviewableFiles[0]).toMatchObject({
        path: "src/app.ts",
      });
      expect(workspace.reviewableFiles[0]?.content).toContain("head");
      expect(workspace.reviewableFiles[0]?.patch).toContain("@@");
      expect(workspace.diff).toContain("diff --git a/src/app.ts b/src/app.ts");

      const checkedOutFile = await readFile(
        path.join(workspace.workingDirectory, "src/app.ts"),
        "utf8",
      );
      expect(checkedOutFile).toContain("head");
    } finally {
      const workingDirectory = workspace.workingDirectory;
      await workspace.cleanup();
      await expect(readFile(path.join(workingDirectory, "src/app.ts"), "utf8")).rejects.toThrow();
    }
  });
});
