import { buildFailureComment, buildReviewMarker } from './summary.js'
import { createChildLogger } from '../logger.js'
import type { AppLogger } from '../logger.js'
import type { CodexRunner } from './codex.js'
import type { ReviewPlatform } from './github-platform.js'
import type { NormalizedPullRequestEvent } from './webhook-event.js'
import type { ReviewWorkspaceManager } from './workspace.js'
import type { DiscussionCacheOptions } from './discussion-cache.js'
import { persistDiscussionContext } from './discussion-cache.js'
import {
  buildPullRequestKey,
  buildRunKey,
  getErrorStatusCode,
  toPullRequestContext,
  toReviewMode,
} from './service-helpers.js'
import type { ActiveRun, ActiveRunRef, ReviewQueueManager } from './review-queue.js'
import { buildAdditionalRevisions, runReviewWorkflow } from './review-workflow.js'

type ReviewExecutionInput = {
  approvedLockEnabled: boolean
  approvedLockedPullRequests: Set<string>
  codex: CodexRunner
  discussionCacheOptions: DiscussionCacheOptions
  event: NormalizedPullRequestEvent
  github: ReviewPlatform
  queueManager: ReviewQueueManager
  activeRunRef: ActiveRunRef
  workspaceManager: ReviewWorkspaceManager
  deliveryLogger: AppLogger
}

export async function reviewPullRequest(input: ReviewExecutionInput): Promise<void> {
  const context = toPullRequestContext(input.event)
  const pullRequestKey = buildPullRequestKey(context)
  const runKey = buildRunKey(context)
  const marker = buildReviewMarker(context.headSha, input.event.deliveryId)
  const startedAt = Date.now()
  const runLogger = createChildLogger(input.deliveryLogger, {
    runKey,
  })
  const run: ActiveRun = {
    abortController: new AbortController(),
    cancellationLogged: false,
    cancellationReason: null,
    context,
    pullRequestKey,
    runKey,
  }
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
    let hasPublishedResult = false

    try {
      hasPublishedResult = await input.github.hasPublishedResult(
        context,
        marker,
      )
    } catch (error) {
      const status = getErrorStatusCode(error)

      if (status === 404) {
        runLogger.warn(
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

    runLogger.info(
      {
        event: 'review.idempotency_checked',
        hasPublishedResult,
        status: 'completed',
      },
      'Review idempotency checked',
    )

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

    const priorSuccessfulReview = await input.github.getPriorSuccessfulReview(
      context,
    )
    const reviewMode = toReviewMode(priorSuccessfulReview)

    runLogger.info(
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

    const prInfo = await input.github.getPRInfo(context)

    runLogger.info(
      {
        commitCount: prInfo.commits.length,
        event: 'review.pr_info_fetched',
        fileCount: prInfo.changedFilePaths.length,
        status: 'completed',
      },
      'PR info fetched',
    )

    if (
      input.queueManager.shouldStopForCancellation(
        runLogger,
        run,
        'after_pr_info',
      )
    ) {
      return
    }

    const workspace = await input.workspaceManager.prepareWorkspace(
      context,
      prInfo,
      createChildLogger(runLogger, {
        component: 'workspace',
      }),
      {
        additionalRevisions: buildAdditionalRevisions({
          currentHeadSha: context.headSha,
          headRef: context.headRef,
          latestReviewedSha: priorSuccessfulReview.latestReviewedSha,
          reviewMode,
        }),
      },
    )

    try {
      runLogger.info(
        {
          event: 'review.workspace_prepared',
          reviewableFileCount: workspace.reviewableFiles.length,
          status: 'completed',
          workingDirectory: workspace.workingDirectory,
        },
        'Review workspace prepared',
      )

      if (
        input.queueManager.shouldStopForCancellation(
          runLogger,
          run,
          'after_workspace_prepare',
        )
      ) {
        return
      }

      const discussionMarkdown =
        await input.github.getPullRequestDiscussionMarkdown(context)
      await persistDiscussionContext({
        context,
        discussionMarkdown,
        runLogger,
        workingDirectory: workspace.workingDirectory,
        options: input.discussionCacheOptions,
      })

      if (
        input.queueManager.shouldStopForCancellation(
          runLogger,
          run,
          'after_discussion_context',
        )
      ) {
        return
      }

      publishedReview = await runReviewWorkflow({
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
