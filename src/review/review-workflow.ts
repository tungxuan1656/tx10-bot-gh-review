import { determineReviewDecision } from './decision.js'
import {
  buildInitialReviewPhase2Prompt,
  buildPhase1Prompt,
  buildReReviewPrompt,
} from './prompt.js'
import { buildFailureComment } from './summary.js'
import { createChildLogger } from '../logger.js'
import { reviewCommentsFileName } from './discussion-cache.js'
import type {
  AdditionalWorkspaceRevision,
} from './types.js'
import {
  buildDecisionMismatchReason,
  resolveReReviewDelta,
} from './service-helpers.js'
import type {
  ActiveRun,
  CodexRunner,
  PriorSuccessfulReviewInfo,
  ReviewWorkflowInput,
} from './types.js'
import {
  publishSuccessfulReview,
  setPullRequestReaction,
} from './review-publishing.js'

const previousReviewedRefName = 'refs/codex-review/previous'

export function buildAdditionalRevisions(input: {
  currentHeadSha: string
  headRef: string
  latestReviewedSha: string | null
  reviewMode: 'initial_review' | 're_review'
}): AdditionalWorkspaceRevision[] {
  if (
    input.reviewMode !== 're_review' ||
    !input.latestReviewedSha ||
    input.latestReviewedSha === input.currentHeadSha
  ) {
    return []
  }

  return [
    {
      revision: input.latestReviewedSha,
      fallbackRef: input.headRef,
      localRef: previousReviewedRefName,
      remote: 'head',
    },
  ]
}

async function runInitialReview(input: {
  context: ReviewWorkflowInput['context']
  reviewablePaths: string[]
  run: ActiveRun
  runLogger: ReviewWorkflowInput['runLogger']
  workspace: ReviewWorkflowInput['workspace']
  codex: ReviewWorkflowInput['codex']
}): Promise<Awaited<ReturnType<CodexRunner['reviewTwoPhase']>>> {
  const phase1Prompt = buildPhase1Prompt({
    owner: input.context.owner,
    repo: input.context.repo,
    pullNumber: input.context.pullNumber,
    title: input.context.title,
    headSha: input.context.headSha,
    prInfoFilePath: 'pr-info.yaml',
  })

  input.runLogger.info(
    {
      event: 'review.prompts_built',
      phase1PromptChars: phase1Prompt.length,
      reviewMode: 'initial_review',
      reviewableFileCount: input.workspace.reviewableFiles.length,
      status: 'completed',
    },
    'Review prompts built',
  )

  return input.codex.reviewTwoPhase(
    {
      abortSignal: input.run.abortController.signal,
      phase1Prompt,
      phase2Prompt: (phase1Summary) =>
        buildInitialReviewPhase2Prompt({
          owner: input.context.owner,
          repo: input.context.repo,
          pullNumber: input.context.pullNumber,
          title: input.context.title,
          headSha: input.context.headSha,
          phase1Summary,
          discussionFilePath: reviewCommentsFileName,
          reviewablePaths: input.reviewablePaths,
        }),
      workingDirectory: input.workspace.workingDirectory,
    },
    createChildLogger(input.runLogger, {
      component: 'codex',
    }),
  )
}

async function runReReview(input: {
  context: ReviewWorkflowInput['context']
  priorSuccessfulReview: PriorSuccessfulReviewInfo
  reviewablePaths: string[]
  run: ActiveRun
  runLogger: ReviewWorkflowInput['runLogger']
  workspace: ReviewWorkflowInput['workspace']
  codex: ReviewWorkflowInput['codex']
}): Promise<Awaited<ReturnType<CodexRunner['review']>>> {
  const delta = resolveReReviewDelta({
    latestReviewedSha: input.priorSuccessfulReview.latestReviewedSha,
    currentHeadSha: input.context.headSha,
    availableRevisionRefs: input.workspace.availableRevisionRefs,
  })

  const prompt = buildReReviewPrompt({
    owner: input.context.owner,
    repo: input.context.repo,
    pullNumber: input.context.pullNumber,
    title: input.context.title,
    headSha: input.context.headSha,
    discussionFilePath: reviewCommentsFileName,
    reviewablePaths: input.reviewablePaths,
    deltaFromRef: delta.deltaFromRef,
    deltaToRef: delta.deltaToRef,
    deltaFromSha: input.priorSuccessfulReview.latestReviewedSha,
    fallbackReason: delta.fallbackReason,
  })

  input.runLogger.info(
    {
      deltaFromRef: delta.deltaFromRef,
      deltaToRef: delta.deltaToRef,
      event: 'review.prompts_built',
      fallbackReason: delta.fallbackReason,
      promptChars: prompt.length,
      reviewMode: 're_review',
      reviewableFileCount: input.workspace.reviewableFiles.length,
      status: 'completed',
    },
    'Review prompts built',
  )

  return input.codex.review(
    {
      abortSignal: input.run.abortController.signal,
      prompt,
      workingDirectory: input.workspace.workingDirectory,
    },
    createChildLogger(input.runLogger, {
      component: 'codex',
    }),
  )
}

export async function runReviewWorkflow(
  input: ReviewWorkflowInput,
): Promise<boolean> {
  const reviewablePaths = input.workspace.reviewableFiles.map((file) => file.path)

  if (input.workspace.reviewableFiles.length === 0) {
    input.runLogger.info(
      {
        event: 'review.completed',
        reason: 'no_reviewable_files',
        status: 'ignored',
      },
      'Review completed',
    )

    await setPullRequestReaction({
      context: input.context,
      deliveryLogger: input.runLogger,
      github: input.github,
      reaction: 'laugh',
      reason: 'no_reviewable_files',
    })
    return false
  }

  await setPullRequestReaction({
    context: input.context,
    deliveryLogger: input.runLogger,
    github: input.github,
    reaction: 'eyes',
    reason: 'review_started',
  })

  const outcome =
    input.reviewMode === 'initial_review'
      ? await runInitialReview({
          codex: input.codex,
          context: input.context,
          reviewablePaths,
          run: input.run,
          runLogger: input.runLogger,
          workspace: input.workspace,
        })
      : await runReReview({
          codex: input.codex,
          context: input.context,
          priorSuccessfulReview: input.priorSuccessfulReview,
          reviewablePaths,
          run: input.run,
          runLogger: input.runLogger,
          workspace: input.workspace,
        })

  if (!outcome.ok) {
    if (
      outcome.cancelled ||
      input.queueManager.shouldStopForCancellation(
        input.runLogger,
        input.run,
        'after_codex',
      )
    ) {
      return false
    }

    input.runLogger.warn(
      {
        event: 'review.codex_failed',
        reason: outcome.reason,
        status: 'failed',
      },
      'Review Codex step failed',
    )

    await input.github.publishFailureComment(
      input.context,
      buildFailureComment({
        headSha: input.context.headSha,
        runToken: input.deliveryId,
        reason: outcome.reason,
      }),
    )
    return false
  }

  input.runLogger.info(
    {
      decision: outcome.result.decision,
      event: 'review.codex_completed',
      findingCount: outcome.result.findings.length,
      score: outcome.result.score,
      status: 'completed',
    },
    'Review Codex step completed',
  )

  if (
    input.queueManager.shouldStopForCancellation(
      input.runLogger,
      input.run,
      'after_codex',
    )
  ) {
    return false
  }

  const expectedDecision = determineReviewDecision(outcome.result.findings)
  if (outcome.result.decision !== expectedDecision) {
    const reason = buildDecisionMismatchReason({
      actualDecision: outcome.result.decision,
      expectedDecision,
    })

    input.runLogger.warn(
      {
        actualDecision: outcome.result.decision,
        event: 'review.codex_contract_mismatch',
        expectedDecision,
        status: 'failed',
      },
      'Review Codex contract mismatch',
    )

    await input.github.publishFailureComment(
      input.context,
      buildFailureComment({
        headSha: input.context.headSha,
        runToken: input.deliveryId,
        reason,
      }),
    )
    return false
  }

  return publishSuccessfulReview({
    approvedLockEnabled: input.approvedLockEnabled,
    approvedLockedPullRequests: input.approvedLockedPullRequests,
    context: input.context,
    deliveryId: input.deliveryId,
    github: input.github,
    outcome,
    queueManager: input.queueManager,
    run: input.run,
    runLogger: input.runLogger,
    reviewableFiles: input.workspace.reviewableFiles,
  })
}
