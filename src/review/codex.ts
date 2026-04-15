import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { reviewResultSchema } from './types.js'
import type { AppLogger } from '../logger.js'
import type { CodexReviewOutcome } from './types.js'

const maxLoggedOutputCharacters = 2_000
const maxLoggedOutputTailCharacters = 1_000

const codexOutputJsonSchema = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      minLength: 1,
    },
    changesOverview: {
      type: 'string',
    },
    score: {
      type: 'number',
      minimum: 0,
      maximum: 10,
    },
    decision: {
      type: 'string',
      enum: ['approve', 'request_changes'],
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: {
            type: 'string',
            enum: ['critical', 'major', 'minor', 'improvement'],
          },
          path: {
            type: 'string',
            minLength: 1,
          },
          line: {
            type: 'integer',
            minimum: 1,
          },
          title: {
            type: 'string',
            minLength: 1,
          },
          comment: {
            type: 'string',
            minLength: 1,
          },
        },
        required: ['severity', 'path', 'line', 'title', 'comment'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'score', 'decision', 'findings'],
  additionalProperties: false,
} as const

/**
 * Strip optional markdown code fences that some models emit around JSON output
 * even when instructed not to (e.g. ```json ... ``` or ``` ... ```).
 */
function stripJsonFences(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(trimmed)
  return fenced?.[1]?.trim() ?? trimmed
}

function detectFailureHint(stderr: string): string | undefined {
  const lower = stderr.toLowerCase()

  if (
    lower.includes('context length') ||
    lower.includes('maximum context') ||
    lower.includes('too many tokens') ||
    lower.includes('input is too long') ||
    lower.includes('prompt is too long')
  ) {
    return 'possible_prompt_too_large'
  }

  if (lower.includes('rate limit') || lower.includes('429')) {
    return 'possible_rate_limited'
  }

  if (
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('authentication')
  ) {
    return 'possible_auth_error'
  }

  if (lower.includes('not found') || lower.includes('no such file')) {
    return 'possible_missing_resource'
  }

  return undefined
}

export type CodexRunner = {
  review(
    input: {
      prompt: string
      workingDirectory: string
      abortSignal?: AbortSignal
    },
    logger?: AppLogger,
  ): Promise<CodexReviewOutcome>

  reviewChained(
    input: {
      phase1Prompt: string
      phase2Prompt: (phase1Output: string) => string
      phase3Prompt: (phase2Output: string) => string
      workingDirectory: string
      abortSignal?: AbortSignal
    },
    logger?: AppLogger,
  ): Promise<CodexReviewOutcome>
}

export function createCodexRunner(input: {
  bin: string
  logger: AppLogger
  model?: string
  timeoutMs?: number
}): CodexRunner {
  const timeoutMs = input.timeoutMs ?? 900_000

  function summarizeOutput(text: string): string | undefined {
    const trimmed = text.trim()

    if (trimmed.length === 0) {
      return undefined
    }

    if (trimmed.length <= maxLoggedOutputCharacters) {
      return trimmed
    }

    return `${trimmed.slice(0, maxLoggedOutputCharacters)}...[truncated]`
  }

  function summarizeOutputTail(text: string): string | undefined {
    const trimmed = text.trim()

    if (trimmed.length === 0) {
      return undefined
    }

    if (trimmed.length <= maxLoggedOutputTailCharacters) {
      return trimmed
    }

    return `...[truncated]${trimmed.slice(-maxLoggedOutputTailCharacters)}`
  }

  /**
   * Run a single Codex invocation.
   * @param validateJson - if true, validates result against reviewResultSchema.
   *                       if false, returns raw text output as the "result" string.
   */
  async function runCodexPhase(phaseInput: {
    prompt: string
    workingDirectory: string
    abortSignal: AbortSignal | undefined
    validateJson: boolean
    phaseLabel: string
    logger: AppLogger
  }): Promise<
    | { ok: true; output: string }
    | { ok: false; reason: string; cancelled?: boolean }
  > {
    if (phaseInput.abortSignal?.aborted) {
      return { ok: false, reason: 'Codex review canceled.', cancelled: true }
    }

    const startedAt = Date.now()
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-review-'))

    try {
      const outputPath = path.join(tempDirectory, 'result.json')
      const outputSchemaPath = path.join(
        tempDirectory,
        'codex-output-schema.json',
      )

      if (phaseInput.validateJson) {
        await writeFile(
          outputSchemaPath,
          JSON.stringify(codexOutputJsonSchema, null, 2),
          'utf8',
        )
      }

      const args = [
        'exec',
        '--cd',
        phaseInput.workingDirectory,
        ...(input.model ? ['--model', input.model] : []),
        '--sandbox',
        'workspace-write',
        '--skip-git-repo-check',
        ...(phaseInput.validateJson
          ? ['--output-schema', outputSchemaPath]
          : []),
        '--output-last-message',
        outputPath,
        '-',
      ]

      phaseInput.logger.debug(
        {
          component: 'codex',
          event: 'codex.phase_started',
          phase: phaseInput.phaseLabel,
          promptChars: phaseInput.prompt.length,
          status: 'started',
          validateJson: phaseInput.validateJson,
          model: input.model,
          workingDirectory: phaseInput.workingDirectory,
        },
        'Codex phase started',
      )

      const child = spawn(input.bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      })

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let cancelled = false
      let abortListener: (() => void) | undefined

      const killChildProcess = () => {
        if (child.exitCode !== null) return
        cancelled = true
        child.kill('SIGTERM')
        const forceKillTimeout = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL')
        }, 2_000)
        forceKillTimeout.unref()
      }

      if (phaseInput.abortSignal) {
        abortListener = () => killChildProcess()
        phaseInput.abortSignal.addEventListener('abort', abortListener, {
          once: true,
        })
        if (phaseInput.abortSignal.aborted) killChildProcess()
      }

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
      child.stdin.end(phaseInput.prompt)

      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        killChildProcess()
      }, timeoutMs)

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      }).finally(() => {
        clearTimeout(timeout)
        if (phaseInput.abortSignal && abortListener) {
          phaseInput.abortSignal.removeEventListener('abort', abortListener)
        }
      })

      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()

      if (timedOut) {
        phaseInput.logger.error(
          {
            component: 'codex',
            durationMs: Date.now() - startedAt,
            event: 'codex.failed',
            phase: phaseInput.phaseLabel,
            reason: 'timeout',
            stderrPreview: summarizeOutput(stderr),
            stdoutPreview: summarizeOutput(stdout),
            stderrBytes: Buffer.byteLength(stderr, 'utf8'),
            stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
            status: 'failed',
            timeoutMs,
          },
          'Codex review failed',
        )
        return { ok: false, reason: `Codex timed out after ${timeoutMs}ms.` }
      }

      if (cancelled) {
        phaseInput.logger.info(
          {
            component: 'codex',
            durationMs: Date.now() - startedAt,
            event: 'codex.canceled',
            phase: phaseInput.phaseLabel,
            status: 'canceled',
          },
          'Codex review canceled',
        )
        return { ok: false, reason: 'Codex review canceled.', cancelled: true }
      }

      if (exitCode !== 0) {
        const failureHint = detectFailureHint(stderr)

        phaseInput.logger.warn(
          {
            component: 'codex',
            event: 'codex.failed',
            exitCode,
            durationMs: Date.now() - startedAt,
            failureHint,
            phase: phaseInput.phaseLabel,
            promptChars: phaseInput.prompt.length,
            reason: 'non_zero_exit',
            stderrPreview: summarizeOutput(stderr),
            stderrTailPreview: summarizeOutputTail(stderr),
            stdoutPreview: summarizeOutput(stdout),
            stdoutTailPreview: summarizeOutputTail(stdout),
            stderrBytes: Buffer.byteLength(stderr, 'utf8'),
            stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
            status: 'failed',
          },
          'Codex review failed',
        )
        return { ok: false, reason: 'Codex returned a non-zero exit code.' }
      }

      const rawOutput = stripJsonFences(
        await readFile(outputPath, 'utf8').catch(() => stdout),
      )

      phaseInput.logger.info(
        {
          component: 'codex',
          durationMs: Date.now() - startedAt,
          event: 'codex.phase_completed',
          outputChars: rawOutput.length,
          phase: phaseInput.phaseLabel,
          status: 'completed',
        },
        'Codex phase completed',
      )

      return { ok: true, output: rawOutput }
    } finally {
      await rm(tempDirectory, { recursive: true, force: true })
    }
  }

  return {
    async review(
      reviewInput: {
        prompt: string
        workingDirectory: string
        abortSignal?: AbortSignal
      },
      loggerOverride?: AppLogger,
    ): Promise<CodexReviewOutcome> {
      if (reviewInput.abortSignal?.aborted) {
        return { ok: false, reason: 'Codex review canceled.', cancelled: true }
      }

      const logger = loggerOverride ?? input.logger
      const startedAt = Date.now()

      logger.debug(
        {
          component: 'codex',
          event: 'codex.started',
          promptChars: reviewInput.prompt.length,
          status: 'started',
          timeoutMs,
          model: input.model,
          workingDirectory: reviewInput.workingDirectory,
        },
        'Codex review started',
      )

      try {
        const phaseResult = await runCodexPhase({
          prompt: reviewInput.prompt,
          workingDirectory: reviewInput.workingDirectory,
          abortSignal: reviewInput.abortSignal,
          validateJson: true,
          phaseLabel: 'single',
          logger,
        })

        if (!phaseResult.ok) {
          return phaseResult
        }

        const parsed: unknown = JSON.parse(phaseResult.output)
        const result = reviewResultSchema.safeParse(parsed)

        if (!result.success) {
          logger.warn(
            {
              component: 'codex',
              durationMs: Date.now() - startedAt,
              event: 'codex.failed',
              issues: result.error.issues,
              outputChars: phaseResult.output.length,
              reason: 'invalid_json',
              status: 'failed',
              workingDirectory: reviewInput.workingDirectory,
            },
            'Codex review failed',
          )
          return {
            ok: false,
            reason: 'Codex returned JSON that did not match the review schema.',
          }
        }

        logger.info(
          {
            component: 'codex',
            decision: result.data.decision,
            durationMs: Date.now() - startedAt,
            event: 'codex.completed',
            findingCount: result.data.findings.length,
            score: result.data.score,
            status: 'completed',
            workingDirectory: reviewInput.workingDirectory,
          },
          'Codex review completed',
        )

        return { ok: true, result: result.data }
      } catch (error) {
        logger.error(
          {
            component: 'codex',
            error,
            event: 'codex.failed',
            reason: 'process_error',
            status: 'failed',
          },
          'Codex review failed',
        )
        return {
          ok: false,
          reason: 'Codex review process could not be started or parsed safely.',
        }
      }
    },

    async reviewChained(
      chainedInput: {
        phase1Prompt: string
        phase2Prompt: (phase1Output: string) => string
        phase3Prompt: (phase2Output: string) => string
        workingDirectory: string
        abortSignal?: AbortSignal
      },
      loggerOverride?: AppLogger,
    ): Promise<CodexReviewOutcome> {
      if (chainedInput.abortSignal?.aborted) {
        return { ok: false, reason: 'Codex review canceled.', cancelled: true }
      }

      const logger = loggerOverride ?? input.logger
      const startedAt = Date.now()

      logger.debug(
        {
          component: 'codex',
          event: 'codex.chained_started',
          status: 'started',
          timeoutMs,
          model: input.model,
          workingDirectory: chainedInput.workingDirectory,
        },
        'Codex chained review started',
      )

      try {
        // Phase 1: summarise PR from pr-info.yaml
        const phase1Result = await runCodexPhase({
          prompt: chainedInput.phase1Prompt,
          workingDirectory: chainedInput.workingDirectory,
          abortSignal: chainedInput.abortSignal,
          validateJson: false,
          phaseLabel: 'phase1',
          logger,
        })

        if (!phase1Result.ok) {
          return phase1Result
        }

        // Phase 2: analyse diff & changes overview
        const phase2Result = await runCodexPhase({
          prompt: chainedInput.phase2Prompt(phase1Result.output),
          workingDirectory: chainedInput.workingDirectory,
          abortSignal: chainedInput.abortSignal,
          validateJson: false,
          phaseLabel: 'phase2',
          logger,
        })

        if (!phase2Result.ok) {
          return phase2Result
        }

        // Phase 3: deep review → JSON output
        const phase3Result = await runCodexPhase({
          prompt: chainedInput.phase3Prompt(phase2Result.output),
          workingDirectory: chainedInput.workingDirectory,
          abortSignal: chainedInput.abortSignal,
          validateJson: true,
          phaseLabel: 'phase3',
          logger,
        })

        if (!phase3Result.ok) {
          return phase3Result
        }

        const parsed: unknown = JSON.parse(phase3Result.output)
        const result = reviewResultSchema.safeParse(parsed)

        if (!result.success) {
          logger.warn(
            {
              component: 'codex',
              durationMs: Date.now() - startedAt,
              event: 'codex.failed',
              issues: result.error.issues,
              outputChars: phase3Result.output.length,
              reason: 'invalid_json',
              status: 'failed',
              workingDirectory: chainedInput.workingDirectory,
            },
            'Codex chained review failed',
          )
          return {
            ok: false,
            reason: 'Codex returned JSON that did not match the review schema.',
          }
        }

        logger.info(
          {
            component: 'codex',
            decision: result.data.decision,
            durationMs: Date.now() - startedAt,
            event: 'codex.completed',
            findingCount: result.data.findings.length,
            score: result.data.score,
            status: 'completed',
            workingDirectory: chainedInput.workingDirectory,
          },
          'Codex chained review completed',
        )

        return { ok: true, result: result.data }
      } catch (error) {
        logger.error(
          {
            component: 'codex',
            error,
            event: 'codex.failed',
            reason: 'process_error',
            status: 'failed',
          },
          'Codex chained review failed',
        )
        return {
          ok: false,
          reason: 'Codex review process could not be started or parsed safely.',
        }
      }
    },
  }
}
