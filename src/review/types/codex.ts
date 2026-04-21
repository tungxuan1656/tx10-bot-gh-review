import type { AppLogger } from '../../types/app.js'
import type { CodexReviewOutcome } from './core.js'

export type CodexRunner = {
  review(
    input: {
      prompt: string
      workingDirectory: string
      abortSignal?: AbortSignal
    },
    logger?: AppLogger,
  ): Promise<CodexReviewOutcome>

  reviewTwoPhase(
    input: {
      phase1Prompt: string
      phase2Prompt: (phase1Output: string) => string
      workingDirectory: string
      abortSignal?: AbortSignal
    },
    logger?: AppLogger,
  ): Promise<CodexReviewOutcome>
}
