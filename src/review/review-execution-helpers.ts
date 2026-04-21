import { buildReviewMarker } from './summary.js'
import { createChildLogger } from '../logger.js'
import {
  buildAdditionalRevisions,
  runReviewWorkflow,
} from './review-workflow.js'
import type { AppLogger } from '../types/app.js'
import type {
  ActiveRun,
  NormalizedPullRequestEvent,
  PriorSuccessfulReviewInfo,
  PreparedReviewWorkspace,
  PullRequestContext,
  ReviewExecutionInput,
  ReviewMode,
} from './types.js'

export function createActiveRun(input: {
  context: PullRequestContext
  runKey: string
  pullRequestKey: string
}): ActiveRun {
  return {
    abortController: new AbortController(),
    cancellationLogged: false,
    cancellationReason: null,
    context: input.context,
    pullRequestKey: input.pullRequestKey,
    runKey: input.runKey,
  }
}

export function createReviewRunLogger(
  deliveryLogger: AppLogger,
  runKey: string,
): AppLogger {
  return createChildLogger(deliveryLogger, { runKey })
}

export function buildRunMarker(
  headSha: string,
  deliveryId: string,
): string {
  return buildReviewMarker(headSha, deliveryId)
}

export async function checkPublishedReviewMarker(input: {
  context: PullRequestContext
  github: ReviewExecutionInput['github']
  marker: string
  runLogger: AppLogger
  getErrorStatusCode: (error: unknown) => number | null
}): Promise<boolean> {
  let hasPublishedResult = false

  try {
    hasPublishedResult = await input.github.hasPublishedResult(
      input.context,
      input.marker,
    )
  } catch (error) {
    const status = input.getErrorStatusCode(error)

    if (status === 404) {
      input.runLogger.warn(
        {
          error,
          event: 'review.idempotency_checked',
          httpStatus: status,
          reason: 'marker_not_found',
          status: 'completed',
        },
        'Review idempotency marker missing',
      )
    } else {
      throw error
    }
  }

  input.runLogger.info(
    {
      event: 'review.idempotency_checked',
      hasPublishedResult,
      status: 'completed',
    },
    'Review idempotency checked',
  )

  return hasPublishedResult
}

export async function loadReviewExecutionContext(input: {
  context: PullRequestContext
  github: ReviewExecutionInput['github']
  runLogger: AppLogger
  toReviewMode: (input: PriorSuccessfulReviewInfo) => ReviewMode
}): Promise<{
  prInfo: Awaited<ReturnType<ReviewExecutionInput['github']['getPRInfo']>>
  priorSuccessfulReview: PriorSuccessfulReviewInfo
  reviewMode: ReviewMode
}> {
  const priorSuccessfulReview = await input.github.getPriorSuccessfulReview(
    input.context,
  )
  const reviewMode = input.toReviewMode(priorSuccessfulReview)

  input.runLogger.info(
    {
      event: 'review.mode_selected',
      hasPriorSuccessfulReview:
        priorSuccessfulReview.hasPriorSuccessfulReview,
      latestReviewedSha: priorSuccessfulReview.latestReviewedSha,
      latestReviewState: priorSuccessfulReview.latestReviewState,
      reviewMode,
      status: 'completed',
    },
    'Review mode selected',
  )

  const prInfo = await input.github.getPRInfo(input.context)

  input.runLogger.info(
    {
      commitCount: prInfo.commits.length,
      event: 'review.pr_info_fetched',
      fileCount: prInfo.changedFilePaths.length,
      status: 'completed',
    },
    'PR info fetched',
  )

  return {
    prInfo,
    priorSuccessfulReview,
    reviewMode,
  }
}

export async function prepareWorkspaceAndDiscussion(input: {
  context: PullRequestContext
  discussionCacheOptions: ReviewExecutionInput['discussionCacheOptions']
  event: NormalizedPullRequestEvent
  github: ReviewExecutionInput['github']
  persistDiscussionContext: (input: {
    context: PullRequestContext
    discussionMarkdown: string
    runLogger: AppLogger
    workingDirectory: string
    options?: ReviewExecutionInput['discussionCacheOptions']
  }) => Promise<void>
  prInfo: Awaited<ReturnType<ReviewExecutionInput['github']['getPRInfo']>>
  priorSuccessfulReview: PriorSuccessfulReviewInfo
  reviewMode: ReviewMode
  run: ActiveRun
  runLogger: AppLogger
  shouldStopForCancellation: ReviewExecutionInput['queueManager']['shouldStopForCancellation']
  workspaceManager: ReviewExecutionInput['workspaceManager']
}): Promise<PreparedReviewWorkspace | null> {
  const workspace = await input.workspaceManager.prepareWorkspace(
    input.context,
    input.prInfo,
    createChildLogger(input.runLogger, {
      component: 'workspace',
    }),
    {
      additionalRevisions: buildAdditionalRevisions({
        currentHeadSha: input.context.headSha,
        headRef: input.context.headRef,
        latestReviewedSha: input.priorSuccessfulReview.latestReviewedSha,
        reviewMode: input.reviewMode,
      }),
    },
  )

  input.runLogger.info(
    {
      event: 'review.workspace_prepared',
      reviewableFileCount: workspace.reviewableFiles.length,
      status: 'completed',
      workingDirectory: workspace.workingDirectory,
    },
    'Review workspace prepared',
  )

  if (
    input.shouldStopForCancellation(
      input.runLogger,
      input.run,
      'after_workspace_prepare',
    )
  ) {
    await workspace.cleanup()
    return null
  }

  const discussionMarkdown =
    await input.github.getPullRequestDiscussionMarkdown(input.context)
  await input.persistDiscussionContext({
    context: input.context,
    discussionMarkdown,
    runLogger: input.runLogger,
    workingDirectory: workspace.workingDirectory,
    options: input.discussionCacheOptions,
  })

  if (
    input.shouldStopForCancellation(
      input.runLogger,
      input.run,
      'after_discussion_context',
    )
  ) {
    await workspace.cleanup()
    return null
  }

  return workspace
}

export async function executeReviewWorkflow(input: {
  approvedLockEnabled: boolean
  approvedLockedPullRequests: Set<string>
  codex: ReviewExecutionInput['codex']
  context: PullRequestContext
  deliveryId: string
  github: ReviewExecutionInput['github']
  priorSuccessfulReview: PriorSuccessfulReviewInfo
  queueManager: ReviewExecutionInput['queueManager']
  reviewMode: ReviewMode
  run: ActiveRun
  runLogger: AppLogger
  workspace: PreparedReviewWorkspace
}): Promise<boolean> {
  return runReviewWorkflow({
    approvedLockEnabled: input.approvedLockEnabled,
    approvedLockedPullRequests: input.approvedLockedPullRequests,
    codex: input.codex,
    context: input.context,
    deliveryId: input.deliveryId,
    github: input.github,
    priorSuccessfulReview: input.priorSuccessfulReview,
    queueManager: input.queueManager,
    reviewMode: input.reviewMode,
    run: input.run,
    runLogger: input.runLogger,
    workspace: input.workspace,
  })
}
