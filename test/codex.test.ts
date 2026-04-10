import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCodexRunner } from "../src/review/codex.js";
import { reviewResultSchema } from "../src/review/types.js";

const createdDirectories: string[] = [];

afterEach(async () => {
  delete process.env.TEST_CAPTURE_PATH;
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

describe("reviewResultSchema", () => {
  it("accepts the expected Codex response shape", () => {
    const parsed = reviewResultSchema.safeParse({
      summary: "Looks mostly good.",
      score: 8.5,
      decision: "comment",
      findings: [
        {
          severity: "medium",
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
});

describe("createCodexRunner", () => {
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
});
