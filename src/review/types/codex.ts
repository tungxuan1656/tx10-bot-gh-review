import type { AppLogger } from '../../types/app.js'
import type { CodexReviewOutcome } from './core.js'

export type CodexInspection = {
  range: string
  paths: string[]
}

export type CodexRunner = {
  review(
    input: {
      prompt: string
      inspection: CodexInspection
      workingDirectory: string
      abortSignal?: AbortSignal
    },
    logger?: AppLogger,
  ): Promise<CodexReviewOutcome>

  reviewTwoPhase(
    input: {
      phase1Prompt: string
      phase2Prompt: (phase1Output: string) => string
      inspection: CodexInspection
      workingDirectory: string
      abortSignal?: AbortSignal
    },
    logger?: AppLogger,
  ): Promise<CodexReviewOutcome>
}
