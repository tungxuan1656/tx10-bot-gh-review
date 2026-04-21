import { toReviewEvent } from './decision.js'
import {
  buildPullRequestKey,
  isInvalidInlineReviewCommentError,
  normalizeOptionalText,
  separateInlineAndOverflowFindings,
} from './service-helpers.js'
import { buildReviewBody } from './summary.js'
import type { AppLogger } from '../types/app.js'
import type {
  ActiveRun,
  CodexReviewSuccess,
  PullRequestContext,
  ReviewEvent,
  ReviewFinding,
  ReviewPlatform,
  ReviewReaction,
  ReviewableFile,
} from './types.js'

export function buildReviewPublication(input: {
  context: PullRequestContext
  deliveryId: string
  outcome: CodexReviewSuccess
  reviewableFiles: ReviewableFile[]
}): {
  comments: Parameters<ReviewPlatform['publishReview']>[0]['comments']
  body: string
  fallbackBody: string
  overflowFindings: ReviewFinding[]
  reviewEvent: ReviewEvent
} {
  const reviewEvent = toReviewEvent(input.outcome.result.decision)
  const { comments, overflowFindings } = separateInlineAndOverflowFindings(
    input.outcome.result.findings,
    input.reviewableFiles,
  )
  const normalizedChangesOverview = normalizeOptionalText(
    input.outcome.result.changesOverview,
  )

  const sharedBodyInput = {
    headSha: input.context.headSha,
    runToken: input.deliveryId,
    score: input.outcome.result.score,
    summary: input.outcome.result.summary,
    ...(normalizedChangesOverview
      ? { changesOverview: normalizedChangesOverview }
      : {}),
    event: reviewEvent,
  }

  return {
    body: buildReviewBody({
      ...sharedBodyInput,
      overflowFindings,
    }),
    comments,
    fallbackBody: buildReviewBody({
      ...sharedBodyInput,
      overflowFindings: input.outcome.result.findings,
    }),
    overflowFindings,
    reviewEvent,
  }
}

export function resolveReviewCompletionReaction(
  reviewEvent: ReviewEvent,
): ReviewReaction {
  return reviewEvent === 'APPROVE' ? 'hooray' : 'confused'
}

export function applyApprovedLock(input: {
  approvedLockEnabled: boolean
  approvedLockedPullRequests: Set<string>
  context: PullRequestContext
  reviewEvent: ReviewEvent
  runLogger: AppLogger
}): void {
  if (input.reviewEvent !== 'APPROVE' || !input.approvedLockEnabled) {
    return
  }

  input.approvedLockedPullRequests.add(buildPullRequestKey(input.context))
  input.runLogger.info(
    {
      event: 'review.approved_locked',
      status: 'completed',
    },
    'Review approved lock applied',
  )
}

export async function publishReviewWithFallback(input: {
  body: string
  comments: Parameters<ReviewPlatform['publishReview']>[0]['comments']
  context: PullRequestContext
  fallbackBody: string
  github: ReviewPlatform
  queueManager: {
    shouldStopForCancellation(
      runLogger: AppLogger,
      run: ActiveRun,
      stage: string,
    ): boolean
  }
  reviewEvent: ReviewEvent
  run: ActiveRun
  runLogger: AppLogger
}): Promise<boolean> {
  try {
    await input.github.publishReview({
      context: input.context,
      body: input.body,
      event: input.reviewEvent,
      comments: input.comments,
    })
    input.runLogger.info(
      {
        event: 'review.published',
        inlineCommentCount: input.comments.length,
        reviewEvent: input.reviewEvent,
        status: 'published',
      },
      'Review published',
    )
    return true
  } catch (error) {
    if (!input.comments.length || !isInvalidInlineReviewCommentError(error)) {
      throw error
    }

    input.runLogger.warn(
      {
        commentCount: input.comments.length,
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
      body: input.fallbackBody,
      event: input.reviewEvent,
      comments: [],
    })
    input.runLogger.info(
      {
        event: 'review.publish_fallback',
        fallbackMode: true,
        reviewEvent: input.reviewEvent,
        status: 'published',
      },
      'Review published',
    )
    return true
  }
}
