import { buildPullRequestKey, routePullRequestEvent } from './service-helpers.js'
import type { AppLogger } from '../types/app.js'
import type {
  NormalizedPullRequestEvent,
  PullRequestContext,
  ReviewPlatform,
  RoutedPullRequestEvent,
} from './types.js'

export const approvedIgnoredReason = 'approved_before'

export function shouldReactToIgnoredEvent(input: {
  hasPendingReviewForPullRequest: boolean
  routedEvent: RoutedPullRequestEvent & { status: 'ignored' }
}): boolean {
  return (
    input.routedEvent.reason !== approvedIgnoredReason &&
    !input.hasPendingReviewForPullRequest
  )
}

export async function resolveRoutedEvent(input: {
  botLogin: string
  deliveryLogger: AppLogger
  event: NormalizedPullRequestEvent
  isApprovedLocked: (context: PullRequestContext, pullRequestKey: string, deliveryLogger: AppLogger) => Promise<boolean>
  context: PullRequestContext
}): Promise<RoutedPullRequestEvent> {
  const routedEventByAction = routePullRequestEvent({
    actionKind: input.event.actionKind,
    botLogin: input.botLogin,
    requestedReviewerLogin: input.event.requestedReviewerLogin,
  })

  if (
    routedEventByAction.status === 'trigger_review' &&
    (await input.isApprovedLocked(
      input.context,
      buildPullRequestKey(input.context),
      input.deliveryLogger,
    ))
  ) {
    return {
      status: 'ignored',
      reason: approvedIgnoredReason,
    }
  }

  return routedEventByAction
}

export async function isApprovedLockedByPlatform(input: {
  approvedLockEnabled: boolean
  approvedLockedPullRequests: Set<string>
  context: PullRequestContext
  deliveryLogger: AppLogger
  github: ReviewPlatform
  pullRequestKey: string
}): Promise<boolean> {
  if (!input.approvedLockEnabled) {
    return false
  }

  if (input.approvedLockedPullRequests.has(input.pullRequestKey)) {
    return true
  }

  try {
    const priorSuccessfulReview = await input.github.getPriorSuccessfulReview(
      input.context,
    )

    if (priorSuccessfulReview.latestReviewState !== 'APPROVED') {
      return false
    }

    input.approvedLockedPullRequests.add(input.pullRequestKey)
    return true
  } catch (error) {
    input.deliveryLogger.warn(
      {
        error,
        event: 'review.approved_lock_lookup_failed',
        status: 'failed',
      },
      'Approved lock lookup failed',
    )
    return false
  }
}
