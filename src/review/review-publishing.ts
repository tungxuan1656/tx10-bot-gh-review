import { toReviewEvent } from './decision.js'
import { buildPullRequestKey, isInvalidInlineReviewCommentError, normalizeOptionalText, separateInlineAndOverflowFindings } from './service-helpers.js'
import { buildReviewBody } from './summary.js'
import type { AppLogger } from '../logger.js'
import type { ActiveRun, ReviewQueueManager } from './review-queue.js'
import type { ReviewPlatform, ReviewReaction } from './github-platform.js'
import type { CodexReviewSuccess, PullRequestContext, ReviewableFile } from './types.js'

export async function setPullRequestReaction(input: {
  context: PullRequestContext
  deliveryLogger: AppLogger
  github: ReviewPlatform
  reaction: ReviewReaction
  reason: string
}): Promise<void> {
  try {
    await input.github.setPullRequestReaction(input.context, input.reaction)
    input.deliveryLogger.info(
      {
        event: 'review.reaction_updated',
        reaction: input.reaction,
        reason: input.reason,
        status: 'completed',
      },
      'Review reaction updated',
    )
  } catch (error) {
    input.deliveryLogger.warn(
      {
        error,
        event: 'review.reaction_failed',
        reaction: input.reaction,
        reason: input.reason,
        status: 'failed',
      },
      'Review reaction update failed',
    )
  }
}

export async function publishSuccessfulReview(input: {
  approvedLockEnabled: boolean
  approvedLockedPullRequests: Set<string>
  context: PullRequestContext
  deliveryId: string
  github: ReviewPlatform
  outcome: CodexReviewSuccess
  queueManager: ReviewQueueManager
  run: ActiveRun
  runLogger: AppLogger
  reviewableFiles: ReviewableFile[]
}): Promise<boolean> {
  const reviewEvent = toReviewEvent(input.outcome.result.decision)
  const { comments, overflowFindings } = separateInlineAndOverflowFindings(
    input.outcome.result.findings,
    input.reviewableFiles,
  )

  input.runLogger.info(
    {
      event: 'review.publish_started',
      inlineCommentCount: comments.length,
      overflowFindingCount: overflowFindings.length,
      reviewEvent,
      status: 'started',
    },
    'Review publish started',
  )

  if (
    input.queueManager.shouldStopForCancellation(
      input.runLogger,
      input.run,
      'before_publish',
    )
  ) {
    return false
  }

  const normalizedChangesOverview = normalizeOptionalText(
    input.outcome.result.changesOverview,
  )

  const body = buildReviewBody({
    headSha: input.context.headSha,
    runToken: input.deliveryId,
    score: input.outcome.result.score,
    summary: input.outcome.result.summary,
    ...(normalizedChangesOverview
      ? { changesOverview: normalizedChangesOverview }
      : {}),
    event: reviewEvent,
    overflowFindings,
  })
  const fallbackBody = buildReviewBody({
    headSha: input.context.headSha,
    runToken: input.deliveryId,
    score: input.outcome.result.score,
    summary: input.outcome.result.summary,
    ...(normalizedChangesOverview
      ? { changesOverview: normalizedChangesOverview }
      : {}),
    event: reviewEvent,
    overflowFindings: input.outcome.result.findings,
  })

  try {
    await input.github.publishReview({
      context: input.context,
      body,
      event: reviewEvent,
      comments,
    })
    input.runLogger.info(
      {
        event: 'review.published',
        inlineCommentCount: comments.length,
        reviewEvent,
        status: 'published',
      },
      'Review published',
    )
  } catch (error) {
    if (!comments.length || !isInvalidInlineReviewCommentError(error)) {
      throw error
    }

    input.runLogger.warn(
      {
        commentCount: comments.length,
        error,
        event: 'review.publish_fallback',
        reason: 'invalid_inline_location',
        status: 'retrying',
      },
      'Review publish fallback',
    )

    if (
      input.queueManager.shouldStopForCancellation(
        input.runLogger,
        input.run,
        'before_publish_fallback',
      )
    ) {
      return false
    }

    await input.github.publishReview({
      context: input.context,
      body: fallbackBody,
      event: reviewEvent,
      comments: [],
    })
    input.runLogger.info(
      {
        event: 'review.publish_fallback',
        fallbackMode: true,
        reviewEvent,
        status: 'published',
      },
      'Review published',
    )
  }

  await setPullRequestReaction({
    context: input.context,
    deliveryLogger: input.runLogger,
    github: input.github,
    reaction: reviewEvent === 'APPROVE' ? 'hooray' : 'confused',
    reason: 'review_published',
  })

  if (reviewEvent === 'APPROVE' && input.approvedLockEnabled) {
    input.approvedLockedPullRequests.add(buildPullRequestKey(input.context))
    input.runLogger.info(
      {
        event: 'review.approved_locked',
        status: 'completed',
      },
      'Review approved lock applied',
    )
  }

  return true
}
