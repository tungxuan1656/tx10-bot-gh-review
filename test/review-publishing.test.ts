import { describe, expect, it, vi } from 'vitest'

import type { AppLogger } from '../src/logger.js'
import {
  publishSuccessfulReview,
  setPullRequestReaction as applyPullRequestReaction,
} from '../src/review/review-publishing.js'
import type { ActiveRun, ReviewQueueManager } from '../src/review/review-queue.js'
import type { ReviewPlatform } from '../src/review/github-platform.js'
import type {
  CodexReviewSuccess,
  PullRequestContext,
  ReviewableFile,
} from '../src/review/types.js'

type PublishReviewInput = Parameters<ReviewPlatform['publishReview']>[0]

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
    title: 'Add review flow',
    htmlUrl: 'https://github.com/acme/repo/pull/42',
    headSha: 'abc123',
    headRef: 'feature/review-flow',
    headCloneUrl: 'https://github.com/acme/repo.git',
    baseSha: 'def456',
    baseRef: 'main',
    baseCloneUrl: 'https://github.com/acme/repo.git',
  }
}

function createReviewOutcome(
  overrides: Partial<CodexReviewSuccess['result']> = {},
): CodexReviewSuccess {
  return {
    ok: true,
    result: {
      summary: 'Looks good.',
      changesOverview: '',
      score: 9,
      decision: 'approve',
      findings: [],
      ...overrides,
    },
  }
}

function createReviewableFiles(): ReviewableFile[] {
  return [
    {
      path: 'src/app.ts',
      patch: '@@ -1 +1 @@\n-console.log("a")\n+console.log("b")',
      content: 'console.log("b")\n',
    },
  ]
}

function createReviewPlatform(overrides: Partial<ReviewPlatform> = {}) {
  const setPullRequestReaction = vi.fn(() => Promise.resolve())
  const publishReview = vi.fn((input: PublishReviewInput) => {
    void input
    return Promise.resolve()
  })

  const platform = {
    publishReview,
    setPullRequestReaction,
    ...overrides,
  } as unknown as ReviewPlatform

  return {
    publishReview,
    setPullRequestReaction,
    platform,
  }
}

function createQueueManager(
  shouldStopForCancellation = false,
): ReviewQueueManager {
  return {
    shouldStopForCancellation: vi.fn(() => shouldStopForCancellation),
  } as unknown as ReviewQueueManager
}

function createRun(): ActiveRun {
  return {
    abortController: new AbortController(),
    cancellationLogged: false,
    cancellationReason: null,
    context: createPullRequestContext(),
    pullRequestKey: 'acme/repo#42',
    runKey: 'acme/repo#42@abc123',
  }
}

describe('review publishing', () => {
  it('updates pull request reactions and logs failures', async () => {
    const logger = createLoggerStub()
    const { platform, setPullRequestReaction } = createReviewPlatform()

    await applyPullRequestReaction({
      context: createPullRequestContext(),
      deliveryLogger: logger,
      github: platform,
      reaction: 'eyes',
      reason: 'review_started',
    })

    expect(setPullRequestReaction).toHaveBeenCalledWith(
      createPullRequestContext(),
      'eyes',
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'review.reaction_updated',
        reason: 'review_started',
        reaction: 'eyes',
        status: 'completed',
      }),
      'Review reaction updated',
    )
  })

  it('logs reaction failures without throwing', async () => {
    const logger = createLoggerStub()
    const { platform, setPullRequestReaction } = createReviewPlatform()
    setPullRequestReaction.mockRejectedValueOnce(new Error('boom'))

    await applyPullRequestReaction({
      context: createPullRequestContext(),
      deliveryLogger: logger,
      github: platform,
      reaction: 'laugh',
      reason: 'ignored_event',
    })

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'review.reaction_failed',
        reason: 'ignored_event',
        reaction: 'laugh',
        status: 'failed',
      }),
      'Review reaction update failed',
    )
  })

  it('falls back to top-level review when inline comments are invalid', async () => {
    const logger = createLoggerStub()
    const publishInputs: PublishReviewInput[] = []
    const { platform, publishReview, setPullRequestReaction } =
      createReviewPlatform()
    publishReview.mockImplementation((input: PublishReviewInput) => {
      publishInputs.push(input)

      if (publishInputs.length === 1) {
        return Promise.reject(
          Object.assign(new Error('review comments is invalid'), {
            status: 422,
          }),
        )
      }

      return Promise.resolve()
    })
    const approvedLockedPullRequests = new Set<string>()
    const outcome = createReviewOutcome({
      decision: 'request_changes',
      findings: [
        {
          severity: 'major',
          path: 'src/app.ts',
          line: 1,
          title: 'Inline issue',
          comment: 'Please fix this.',
        },
      ],
    })

    const published = await publishSuccessfulReview({
      approvedLockEnabled: true,
      approvedLockedPullRequests,
      context: createPullRequestContext(),
      deliveryId: 'delivery-123',
      github: platform,
      outcome,
      queueManager: createQueueManager(false),
      run: createRun(),
      runLogger: logger,
      reviewableFiles: createReviewableFiles(),
    })

    expect(published).toBe(true)
    expect(publishInputs).toHaveLength(2)
    expect(publishInputs[0]?.comments ?? []).toHaveLength(1)
    expect(publishInputs[1]?.comments ?? []).toHaveLength(0)
    expect(setPullRequestReaction).toHaveBeenCalledWith(
      createPullRequestContext(),
      'confused',
    )
    expect(approvedLockedPullRequests.size).toBe(0)
  })

  it('publishes an approved review and applies approved lock', async () => {
    const logger = createLoggerStub()
    const { platform, publishReview, setPullRequestReaction } =
      createReviewPlatform()
    const approvedLockedPullRequests = new Set<string>()

    const published = await publishSuccessfulReview({
      approvedLockEnabled: true,
      approvedLockedPullRequests,
      context: createPullRequestContext(),
      deliveryId: 'delivery-123',
      github: platform,
      outcome: createReviewOutcome(),
      queueManager: createQueueManager(false),
      run: createRun(),
      runLogger: logger,
      reviewableFiles: createReviewableFiles(),
    })

    expect(published).toBe(true)
    expect(publishReview).toHaveBeenCalledTimes(1)
    expect(setPullRequestReaction).toHaveBeenCalledWith(
      createPullRequestContext(),
      'hooray',
    )
    expect(approvedLockedPullRequests.has('acme/repo#42')).toBe(true)
  })

  it('skips publish when cancellation is requested before publishing', async () => {
    const logger = createLoggerStub()
    const { platform, publishReview, setPullRequestReaction } =
      createReviewPlatform()
    const approvedLockedPullRequests = new Set<string>()

    const published = await publishSuccessfulReview({
      approvedLockEnabled: true,
      approvedLockedPullRequests,
      context: createPullRequestContext(),
      deliveryId: 'delivery-123',
      github: platform,
      outcome: createReviewOutcome(),
      queueManager: createQueueManager(true),
      run: createRun(),
      runLogger: logger,
      reviewableFiles: createReviewableFiles(),
    })

    expect(published).toBe(false)
    expect(publishReview).not.toHaveBeenCalled()
    expect(setPullRequestReaction).not.toHaveBeenCalled()
  })
})
