import { reviewResultSchema } from './types.js'
import type { AppLogger } from '../types/app.js'
import type { CodexReviewOutcome, CodexRunner } from './types.js'
import { runCodexPhase } from './codex-process.js'

export type { CodexRunner } from './types.js'

export function createCodexRunner(input: {
  bin: string
  logger: AppLogger
  model?: string
  timeoutMs?: number
}): CodexRunner {
  const timeoutMs = input.timeoutMs ?? 900_000

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
          bin: input.bin,
          prompt: reviewInput.prompt,
          workingDirectory: reviewInput.workingDirectory,
          abortSignal: reviewInput.abortSignal,
          validateJson: true,
          phaseLabel: 'single',
          logger,
          model: input.model,
          timeoutMs,
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

    async reviewTwoPhase(
      chainedInput: {
        phase1Prompt: string
        phase2Prompt: (phase1Output: string) => string
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
          event: 'codex.two_phase_started',
          status: 'started',
          timeoutMs,
          model: input.model,
          workingDirectory: chainedInput.workingDirectory,
        },
        'Codex two-phase review started',
      )

      try {
        const phase1Result = await runCodexPhase({
          bin: input.bin,
          prompt: chainedInput.phase1Prompt,
          workingDirectory: chainedInput.workingDirectory,
          abortSignal: chainedInput.abortSignal,
          validateJson: false,
          phaseLabel: 'phase1',
          logger,
          model: input.model,
          timeoutMs,
        })

        if (!phase1Result.ok) {
          return phase1Result
        }

        const phase2Result = await runCodexPhase({
          bin: input.bin,
          prompt: chainedInput.phase2Prompt(phase1Result.output),
          workingDirectory: chainedInput.workingDirectory,
          abortSignal: chainedInput.abortSignal,
          validateJson: true,
          phaseLabel: 'phase2',
          logger,
          model: input.model,
          timeoutMs,
        })

        if (!phase2Result.ok) {
          return phase2Result
        }

        const parsed: unknown = JSON.parse(phase2Result.output)
        const result = reviewResultSchema.safeParse(parsed)

        if (!result.success) {
          logger.warn(
            {
              component: 'codex',
              durationMs: Date.now() - startedAt,
              event: 'codex.failed',
              issues: result.error.issues,
              outputChars: phase2Result.output.length,
              reason: 'invalid_json',
              status: 'failed',
              workingDirectory: chainedInput.workingDirectory,
            },
            'Codex two-phase review failed',
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
          'Codex two-phase review completed',
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
          'Codex two-phase review failed',
        )
        return {
          ok: false,
          reason: 'Codex review process could not be started or parsed safely.',
        }
      }
    },
  }
}
