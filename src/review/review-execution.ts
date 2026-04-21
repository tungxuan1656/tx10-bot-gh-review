import { buildFailureComment } from './summary.js'
import { persistDiscussionContext } from './discussion-cache.js'
import {
  buildPullRequestKey,
  buildRunKey,
  getErrorStatusCode,
  toPullRequestContext,
  toReviewMode,
} from './service-helpers.js'
import type {
  ReviewExecutionInput,
} from './types.js'
import {
  buildRunMarker,
  checkPublishedReviewMarker,
  createActiveRun,
  createReviewRunLogger,
  executeReviewWorkflow,
  loadReviewExecutionContext,
  prepareWorkspaceAndDiscussion,
} from './review-execution-helpers.js'

export async function reviewPullRequest(input: ReviewExecutionInput): Promise<void> {
  const context = toPullRequestContext(input.event)
  const pullRequestKey = buildPullRequestKey(context)
  const runKey = buildRunKey(context)
  const marker = buildRunMarker(context.headSha, input.event.deliveryId)
  const startedAt = Date.now()
  const runLogger = createReviewRunLogger(input.deliveryLogger, runKey)
  const run = createActiveRun({
    context,
    pullRequestKey,
    runKey,
  })
  let publishedReview = false

  input.activeRunRef.current = run

  runLogger.info(
    {
      event: 'review.started',
      queueLength: input.queueManager.queueLength,
      status: 'started',
    },
    'Review started',
  )

  try {
    const hasPublishedResult = await checkPublishedReviewMarker({
      context,
      getErrorStatusCode,
      github: input.github,
      marker,
      runLogger,
    })

    if (hasPublishedResult) {
      runLogger.info(
        {
          event: 'review.completed',
          reason: 'already_published',
          status: 'ignored',
        },
        'Review completed',
      )
      return
    }

    if (
      input.queueManager.shouldStopForCancellation(
        runLogger,
        run,
        'after_idempotency',
      )
    ) {
      return
    }

    const {
      prInfo,
      priorSuccessfulReview,
      reviewMode,
    } = await loadReviewExecutionContext({
      context,
      github: input.github,
      runLogger,
      toReviewMode,
    })

    if (
      input.queueManager.shouldStopForCancellation(
        runLogger,
        run,
        'after_pr_info',
      )
    ) {
      return
    }

    const workspace = await prepareWorkspaceAndDiscussion({
      context,
      discussionCacheOptions: input.discussionCacheOptions,
      event: input.event,
      github: input.github,
      persistDiscussionContext,
      prInfo,
      priorSuccessfulReview,
      reviewMode,
      run,
      runLogger,
      shouldStopForCancellation: input.queueManager.shouldStopForCancellation.bind(
        input.queueManager,
      ),
      workspaceManager: input.workspaceManager,
    })

    if (!workspace) {
      return
    }

    try {
      publishedReview = await executeReviewWorkflow({
        approvedLockEnabled: input.approvedLockEnabled,
        approvedLockedPullRequests: input.approvedLockedPullRequests,
        codex: input.codex,
        context,
        deliveryId: input.event.deliveryId,
        github: input.github,
        priorSuccessfulReview,
        queueManager: input.queueManager,
        reviewMode,
        run,
        runLogger,
        workspace,
      })
    } finally {
      await workspace.cleanup()
    }
  } catch (error) {
    if (input.queueManager.shouldStopForCancellation(runLogger, run, 'on_error')) {
      return
    }

    runLogger.error(
      {
        error,
        event: 'review.failed',
        status: 'failed',
      },
      'Review failed',
    )

    try {
      await input.github.publishFailureComment(
        context,
        buildFailureComment({
          headSha: context.headSha,
          runToken: input.event.deliveryId,
          reason: 'The review pipeline failed before it could submit a review.',
        }),
      )
    } catch (failureCommentError) {
      runLogger.error(
        {
          event: 'review.failed',
          failureCommentError,
          originalError: error,
          reason: 'failure_comment_failed',
          status: 'failed',
        },
        'Review failure comment publish failed',
      )
    }
  } finally {
    if (input.activeRunRef.current?.runKey === runKey) {
      input.activeRunRef.current = null
    }

    if (publishedReview && run.abortController.signal.aborted) {
      runLogger.info(
        {
          event: 'review.cancel_missed',
          reason: run.cancellationReason ?? 'cancel_requested',
          status: 'cancel_missed',
        },
        'Review cancel missed',
      )
    }

    runLogger.info(
      {
        durationMs: Date.now() - startedAt,
        event: 'review.completed',
        status: 'completed',
      },
      'Review completed',
    )
  }
}
