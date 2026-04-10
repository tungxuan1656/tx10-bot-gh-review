import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { reviewResultSchema } from "./types.js";
import type { AppLogger } from "../logger.js";
import type { CodexReviewOutcome } from "./types.js";

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "score", "decision", "findings"],
  properties: {
    summary: { type: "string" },
    score: { type: "number", minimum: 0, maximum: 10 },
    decision: {
      type: "string",
      enum: ["approve", "comment", "request_changes"],
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "path", "line", "title", "comment"],
        properties: {
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low", "info"],
          },
          path: { type: "string" },
          line: { type: "integer", minimum: 1 },
          title: { type: "string" },
          comment: { type: "string" },
        },
      },
    },
  },
} as const;

export type CodexRunner = {
  review(
    input: {
      prompt: string;
      workingDirectory: string;
    },
    logger?: AppLogger,
  ): Promise<CodexReviewOutcome>;
};

export function createCodexRunner(input: {
  bin: string;
  logger: AppLogger;
  timeoutMs?: number;
}): CodexRunner {
  const timeoutMs = input.timeoutMs ?? 30_000;

  return {
    async review(
      reviewInput: {
        prompt: string;
        workingDirectory: string;
      },
      loggerOverride?: AppLogger,
    ): Promise<CodexReviewOutcome> {
      const logger = loggerOverride ?? input.logger;
      const startedAt = Date.now();
      const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-review-"));
      const prompt = reviewInput.prompt;

      logger.debug(
        {
          component: "codex",
          event: "codex.started",
          promptChars: prompt.length,
          status: "started",
          timeoutMs,
          workingDirectory: reviewInput.workingDirectory,
        },
        "Codex review started",
      );

      try {
        const schemaPath = path.join(tempDirectory, "schema.json");
        const outputPath = path.join(tempDirectory, "result.json");

        await writeFile(schemaPath, JSON.stringify(outputSchema), "utf8");

        const child = spawn(
          input.bin,
          [
            "exec",
            "--cd",
            reviewInput.workingDirectory,
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--output-schema",
            schemaPath,
            "--output-last-message",
            outputPath,
            "-",
          ],
          {
            stdio: ["pipe", "pipe", "pipe"],
            env: process.env,
          },
        );

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        child.stdout.on("data", (chunk: Buffer) => {
          stdoutChunks.push(chunk);
        });

        child.stderr.on("data", (chunk: Buffer) => {
          stderrChunks.push(chunk);
        });

        child.stdin.end(prompt);

        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs);

        const exitCode = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        }).finally(() => {
          clearTimeout(timeout);
        });

        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();

        if (timedOut) {
          logger.error(
            {
              component: "codex",
              durationMs: Date.now() - startedAt,
              event: "codex.failed",
              promptChars: prompt.length,
              reason: "timeout",
              stderrBytes: Buffer.byteLength(stderr, "utf8"),
              status: "failed",
              timeoutMs,
              workingDirectory: reviewInput.workingDirectory,
            },
            "Codex review failed",
          );
          return {
            ok: false,
            reason: `Codex timed out after ${timeoutMs}ms.`,
          };
        }

        if (exitCode !== 0) {
          logger.warn(
            {
              component: "codex",
              event: "codex.failed",
              exitCode,
              durationMs: Date.now() - startedAt,
              reason: "non_zero_exit",
              stderrBytes: Buffer.byteLength(stderr, "utf8"),
              status: "failed",
              workingDirectory: reviewInput.workingDirectory,
            },
            "Codex review failed",
          );
          return {
            ok: false,
            reason: "Codex returned a non-zero exit code.",
          };
        }

        const rawOutput = await readFile(outputPath, "utf8").catch(() => stdout);
        const parsed: unknown = JSON.parse(rawOutput);
        const result = reviewResultSchema.safeParse(parsed);

        if (!result.success) {
          logger.warn(
            {
              component: "codex",
              durationMs: Date.now() - startedAt,
              event: "codex.failed",
              issues: result.error.issues,
              outputChars: rawOutput.length,
              reason: "invalid_json",
              status: "failed",
              workingDirectory: reviewInput.workingDirectory,
            },
            "Codex review failed",
          );
          return {
            ok: false,
            reason: "Codex returned JSON that did not match the review schema.",
          };
        }

        logger.info(
          {
            component: "codex",
            decision: result.data.decision,
            durationMs: Date.now() - startedAt,
            event: "codex.completed",
            findingCount: result.data.findings.length,
            score: result.data.score,
            status: "completed",
            workingDirectory: reviewInput.workingDirectory,
          },
          "Codex review completed",
        );

        return {
          ok: true,
          result: result.data,
        };
      } catch (error) {
        logger.error(
          {
            component: "codex",
            error,
            event: "codex.failed",
            reason: "process_error",
            status: "failed",
          },
          "Codex review failed",
        );
        return {
          ok: false,
          reason: "Codex review process could not be started or parsed safely.",
        };
      } finally {
        await rm(tempDirectory, { recursive: true, force: true });
      }
    },
  };
}
