import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCodexRunner } from "../src/review/codex.js";
import { reviewResultSchema } from "../src/review/types.js";

const createdDirectories: string[] = [];

afterEach(async () => {
  delete process.env.TEST_CAPTURE_PATH;
  delete process.env.TEST_CANCEL_PATH;
  await Promise.all(
    createdDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createFakeCodexBinary(): Promise<{
  binPath: string;
  capturePath: string;
}> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-runner-test-"));
  createdDirectories.push(tempDirectory);
  const capturePath = path.join(tempDirectory, "capture.json");
  const binPath = path.join(tempDirectory, "fake-codex.mjs");

  await writeFile(
    binPath,
    [
      "#!/usr/bin/env node",
      "import { readFile, writeFile } from 'node:fs/promises';",
      "",
      "const args = process.argv.slice(2);",
      "const stdin = await new Promise((resolve, reject) => {",
      "  const chunks = [];",
      "  process.stdin.on('data', (chunk) => chunks.push(chunk));",
      "  process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));",
      "  process.stdin.on('error', reject);",
      "});",
      "const schemaIndex = args.indexOf('--output-schema');",
      "const outputIndex = args.indexOf('--output-last-message');",
      "const schemaPath = args[schemaIndex + 1];",
      "const outputPath = args[outputIndex + 1];",
      "await writeFile(",
      "  process.env.TEST_CAPTURE_PATH,",
      "  JSON.stringify({",
      "    args,",
      "    cwd: process.cwd(),",
      "    schema: JSON.parse(await readFile(schemaPath, 'utf8')),",
      "    stdin,",
      "  }),",
      ");",
      "await writeFile(",
      "  outputPath,",
      "  JSON.stringify({ summary: 'ok', score: 9, decision: 'approve', findings: [] }),",
      ");",
    ].join("\n"),
    "utf8",
  );
  await chmod(binPath, 0o755);

  return {
    binPath,
    capturePath,
  };
}

async function createSlowFakeCodexBinary(): Promise<string> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-runner-slow-test-"));
  createdDirectories.push(tempDirectory);
  const binPath = path.join(tempDirectory, "slow-fake-codex.mjs");

  await writeFile(
    binPath,
    [
      "#!/usr/bin/env node",
      "await new Promise((resolve) => setTimeout(resolve, 200));",
      "process.stdout.write('still running');",
    ].join("\n"),
    "utf8",
  );
  await chmod(binPath, 0o755);

  return binPath;
}

async function createAbortAwareFakeCodexBinary(): Promise<{
  binPath: string;
  cancelPath: string;
}> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-runner-cancel-test-"));
  createdDirectories.push(tempDirectory);
  const cancelPath = path.join(tempDirectory, "cancelled.txt");
  const binPath = path.join(tempDirectory, "cancel-fake-codex.mjs");

  await writeFile(
    binPath,
    [
      "#!/usr/bin/env node",
      "import { writeFile } from 'node:fs/promises';",
      "process.on('SIGTERM', async () => {",
      "  await writeFile(process.env.TEST_CANCEL_PATH, 'sigterm', 'utf8');",
      "  process.exit(0);",
      "});",
      "await new Promise(() => {});",
    ].join("\n"),
    "utf8",
  );
  await chmod(binPath, 0o755);

  return {
    binPath,
    cancelPath,
  };
}

describe("reviewResultSchema", () => {
  it("accepts the expected Codex response shape", () => {
    const parsed = reviewResultSchema.safeParse({
      summary: "Looks mostly good.",
      score: 8.5,
      decision: "approve",
      findings: [
        {
          severity: "minor",
          path: "src/app.ts",
          line: 14,
          title: "Unhandled JSON parsing",
          comment: "Wrap JSON.parse in try/catch.",
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects invalid finding shapes", () => {
    const parsed = reviewResultSchema.safeParse({
      summary: "Nope.",
      score: 12,
      decision: "approve",
      findings: [],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects legacy decision and severity values", () => {
    const parsed = reviewResultSchema.safeParse({
      summary: "Legacy response.",
      score: 8,
      decision: "comment",
      findings: [
        {
          severity: "medium",
          path: "src/app.ts",
          line: 14,
          title: "Legacy severity",
          comment: "Old taxonomy should fail.",
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });
});

describe("createCodexRunner", () => {
  it("defaults to a 15 minute timeout budget", async () => {
    const { binPath, capturePath } = await createFakeCodexBinary();
    process.env.TEST_CAPTURE_PATH = capturePath;
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const runner = createCodexRunner({
      bin: binPath,
      logger: logger as never,
    });

    await runner.review({
      prompt: "Review this diff",
      workingDirectory: "/tmp/pr-workspace",
    });

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "codex.started",
        timeoutMs: 900_000,
      }),
      "Codex review started",
    );
  });

  it("passes the workspace directory, read-only sandbox, and output schema to codex exec", async () => {
    const { binPath, capturePath } = await createFakeCodexBinary();
    process.env.TEST_CAPTURE_PATH = capturePath;
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const runner = createCodexRunner({
      bin: binPath,
      logger: logger as never,
      timeoutMs: 5_000,
    });

    const outcome = await runner.review({
      prompt: "Review this diff",
      workingDirectory: "/tmp/pr-workspace",
    });

    expect(outcome).toEqual({
      ok: true,
      result: {
        summary: "ok",
        score: 9,
        decision: "approve",
        findings: [],
      },
    });

    const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
      args: string[];
      cwd: string;
      schema: {
        properties: {
          findings: unknown;
        };
      };
      stdin: string;
    };

    expect(capture.args).toContain("exec");
    expect(capture.args).toContain("--cd");
    expect(capture.args).toContain("/tmp/pr-workspace");
    expect(capture.args).toContain("--sandbox");
    expect(capture.args).toContain("read-only");
    expect(capture.args).toContain("--output-schema");
    expect(capture.args).toContain("--output-last-message");
    expect(capture.stdin).toBe("Review this diff");
    expect(capture.schema.properties.findings).toBeDefined();
    expect(capture.cwd).toBe(process.cwd());
  });

  it("times out using the configured timeout and logs bounded output previews", async () => {
    const binPath = await createSlowFakeCodexBinary();
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const runner = createCodexRunner({
      bin: binPath,
      logger: logger as never,
      timeoutMs: 50,
    });

    const outcome = await runner.review({
      prompt: "Review this diff",
      workingDirectory: "/tmp/pr-workspace",
    });

    expect(outcome).toEqual({
      ok: false,
      reason: "Codex timed out after 50ms.",
    });
    const loggedTimeoutPayload = logger.error.mock.calls[0]?.[0] as {
      event: string;
      reason: string;
      timeoutMs: number;
      stdoutBytes: number;
      stderrBytes: number;
    };

    expect(loggedTimeoutPayload.event).toBe("codex.failed");
    expect(loggedTimeoutPayload.reason).toBe("timeout");
    expect(loggedTimeoutPayload.timeoutMs).toBe(50);
    expect(typeof loggedTimeoutPayload.stdoutBytes).toBe("number");
    expect(typeof loggedTimeoutPayload.stderrBytes).toBe("number");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "codex.failed",
        reason: "timeout",
        timeoutMs: 50,
      }),
      "Codex review failed",
    );
  });

  it("cancels the Codex process when abort signal is triggered", async () => {
    const { binPath, cancelPath } = await createAbortAwareFakeCodexBinary();
    process.env.TEST_CANCEL_PATH = cancelPath;
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const runner = createCodexRunner({
      bin: binPath,
      logger: logger as never,
      timeoutMs: 5_000,
    });
    const controller = new AbortController();

    const reviewPromise = runner.review({
      abortSignal: controller.signal,
      prompt: "Review this diff",
      workingDirectory: "/tmp/pr-workspace",
    });

    await Promise.resolve();
    controller.abort();
    const outcome = await reviewPromise;

    expect(outcome).toEqual({
      ok: false,
      reason: "Codex review canceled.",
      cancelled: true,
    });
    try {
      const cancelMarker = await readFile(cancelPath, "utf8");
      expect(cancelMarker).toBe("sigterm");
    } catch {
      expect(outcome).toMatchObject({
        cancelled: true,
        ok: false,
      });
    }
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "codex.canceled",
        status: "canceled",
      }),
      "Codex review canceled",
    );
  });
});
