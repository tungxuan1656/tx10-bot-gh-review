import { describe, expect, it, vi } from 'vitest'

import type { AppLogger } from '../src/logger.js'
import {
  approvedIgnoredReason,
  isApprovedLockedByPlatform,
  resolveRoutedEvent,
  shouldReactToIgnoredEvent,
} from '../src/review/service-helpers-runtime.js'
import type {
  NormalizedPullRequestEvent,
  PullRequestContext,
  ReviewPlatform,
} from '../src/review/types.js'

function createLoggerStub(): AppLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as AppLogger
}

function createPullRequestContext(): PullRequestContext {
  return {
    action: 'review_requested',
    installationId: 0,
    owner: 'acme',
    repo: 'repo',
    pullNumber: 42,
    title: 'Example',
    htmlUrl: 'https://github.com/acme/repo/pull/42',
    headSha: 'abc123',
    headRef: 'feature/example',
    headCloneUrl: 'https://github.com/acme/repo.git',
    baseSha: 'def456',
    baseRef: 'main',
    baseCloneUrl: 'https://github.com/acme/repo.git',
  }
}

function createEvent(
  overrides: Partial<NormalizedPullRequestEvent> = {},
): NormalizedPullRequestEvent {
  return {
    action: 'review_requested',
    actionKind: 'review_requested',
    afterSha: null,
    baseSha: 'def456',
    beforeSha: null,
    botStillRequested: null,
    deliveryId: 'delivery-123',
    eventName: 'pull_request',
    headSha: 'abc123',
    htmlUrl: 'https://github.com/acme/repo/pull/42',
    owner: 'acme',
    pullNumber: 42,
    repo: 'repo',
    requestedReviewerLogin: 'review-bot',
    requestedReviewerLogins: ['review-bot'],
    senderLogin: 'octocat',
    title: 'Example',
    headRef: 'feature/example',
    headCloneUrl: 'https://github.com/acme/repo.git',
    baseRef: 'main',
    baseCloneUrl: 'https://github.com/acme/repo.git',
    ...overrides,
  }
}

describe('service runtime helpers', () => {
  it('reacts only for ignored events that are not approved-before and not pending', () => {
    expect(
      shouldReactToIgnoredEvent({
        hasPendingReviewForPullRequest: false,
        routedEvent: {
          status: 'ignored',
          reason: 'unsupported_action',
        },
      }),
    ).toBe(true)

    expect(
      shouldReactToIgnoredEvent({
        hasPendingReviewForPullRequest: false,
        routedEvent: {
          status: 'ignored',
          reason: approvedIgnoredReason,
        },
      }),
    ).toBe(false)

    expect(
      shouldReactToIgnoredEvent({
        hasPendingReviewForPullRequest: true,
        routedEvent: {
          status: 'ignored',
          reason: 'unsupported_action',
        },
      }),
    ).toBe(false)
  })

  it('resolves approved-before when action triggers review and approved lock is active', async () => {
    const routedEvent = await resolveRoutedEvent({
      botLogin: 'review-bot',
      context: createPullRequestContext(),
      deliveryLogger: createLoggerStub(),
      event: createEvent(),
      isApprovedLocked: vi.fn().mockResolvedValue(true),
    })

    expect(routedEvent).toEqual({
      status: 'ignored',
      reason: approvedIgnoredReason,
    })
  })

  it('returns routePullRequestEvent result unchanged when no approved lock applies', async () => {
    const routedEvent = await resolveRoutedEvent({
      botLogin: 'review-bot',
      context: createPullRequestContext(),
      deliveryLogger: createLoggerStub(),
      event: createEvent({
        action: 'review_request_removed',
        actionKind: 'review_request_removed',
      }),
      isApprovedLocked: vi.fn().mockResolvedValue(false),
    })

    expect(routedEvent).toEqual({
      status: 'cancel_requested',
      reason: 'cancel_requested',
    })
  })

  it('checks approved lock state from memory and platform lookup', async () => {
    const logger = createLoggerStub()
    const approvedLockedPullRequests = new Set<string>(['acme/repo#42'])

    await expect(
      isApprovedLockedByPlatform({
        approvedLockEnabled: true,
        approvedLockedPullRequests,
        context: createPullRequestContext(),
        deliveryLogger: logger,
        github: {} as ReviewPlatform,
        pullRequestKey: 'acme/repo#42',
      }),
    ).resolves.toBe(true)

    const unlocked = new Set<string>()
    const github = {
      getPriorSuccessfulReview: vi.fn().mockResolvedValue({
        hasPriorSuccessfulReview: true,
        latestReviewedSha: 'abc123',
        latestReviewState: 'APPROVED',
      }),
    } as unknown as ReviewPlatform

    await expect(
      isApprovedLockedByPlatform({
        approvedLockEnabled: true,
        approvedLockedPullRequests: unlocked,
        context: createPullRequestContext(),
        deliveryLogger: logger,
        github,
        pullRequestKey: 'acme/repo#42',
      }),
    ).resolves.toBe(true)
    expect(unlocked.has('acme/repo#42')).toBe(true)
  })

  it('returns false and logs when approved lock lookup fails', async () => {
    const logger = createLoggerStub()
    const github = {
      getPriorSuccessfulReview: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as ReviewPlatform

    await expect(
      isApprovedLockedByPlatform({
        approvedLockEnabled: true,
        approvedLockedPullRequests: new Set<string>(),
        context: createPullRequestContext(),
        deliveryLogger: logger,
        github,
        pullRequestKey: 'acme/repo#42',
      }),
    ).resolves.toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'review.approved_lock_lookup_failed',
        status: 'failed',
      }),
      'Approved lock lookup failed',
    )
  })
})
