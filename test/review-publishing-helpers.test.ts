import { describe, expect, it, vi } from 'vitest'

import type { AppLogger } from '../src/logger.js'
import {
  applyApprovedLock,
  buildReviewPublication,
  publishReviewWithFallback,
  resolveReviewCompletionReaction,
} from '../src/review/review-publishing-helpers.js'
import type { ReviewPlatform } from '../src/review/github-platform.js'
import type { ActiveRun } from '../src/review/review-queue.js'
import type {
  CodexReviewSuccess,
  PullRequestContext,
  ReviewableFile,
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

describe('review publishing helpers', () => {
  it('builds review publication payloads with trimmed overview and overflow fallback body', () => {
    const publication = buildReviewPublication({
      context: createPullRequestContext(),
      deliveryId: 'delivery-123',
      outcome: createReviewOutcome({
        changesOverview: '  concise overview  ',
        findings: [
          {
            severity: 'minor',
            path: 'src/app.ts',
            line: 99,
            title: 'Overflow issue',
            comment: 'Needs top-level fallback.',
          },
        ],
      }),
      reviewableFiles: createReviewableFiles(),
    })

    expect(publication.reviewEvent).toBe('APPROVE')
    expect(publication.comments).toHaveLength(0)
    expect(publication.overflowFindings).toHaveLength(1)
    expect(publication.body).toContain('concise overview')
    expect(publication.fallbackBody).toContain('Additional findings')
  })

  it('publishes with fallback when inline comments are invalid', async () => {
    const logger = createLoggerStub()
    const publishReview = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('review comments is invalid'), {
          status: 422,
        }),
      )
      .mockResolvedValueOnce(undefined)
    const github = {
      publishReview,
    } as unknown as ReviewPlatform

    const published = await publishReviewWithFallback({
      body: 'primary',
      comments: [
        {
          body: 'inline',
          line: 1,
          path: 'src/app.ts',
          side: 'RIGHT',
        },
      ],
      context: createPullRequestContext(),
      fallbackBody: 'fallback',
      github,
      queueManager: {
        shouldStopForCancellation: vi.fn(() => false),
      },
      reviewEvent: 'REQUEST_CHANGES',
      run: createRun(),
      runLogger: logger,
    })

    expect(published).toBe(true)
    expect(publishReview).toHaveBeenCalledTimes(2)
    expect(publishReview.mock.calls[1]?.[0]).toMatchObject({
      body: 'fallback',
      comments: [],
    })
  })

  it('returns false when cancellation is requested before fallback publish', async () => {
    const logger = createLoggerStub()
    const github = {
      publishReview: vi.fn().mockRejectedValue(
        Object.assign(new Error('review comments is invalid'), {
          status: 422,
        }),
      ),
    } as unknown as ReviewPlatform

    const published = await publishReviewWithFallback({
      body: 'primary',
      comments: [
        {
          body: 'inline',
          line: 1,
          path: 'src/app.ts',
          side: 'RIGHT',
        },
      ],
      context: createPullRequestContext(),
      fallbackBody: 'fallback',
      github,
      queueManager: {
        shouldStopForCancellation: vi.fn(() => true),
      },
      reviewEvent: 'REQUEST_CHANGES',
      run: createRun(),
      runLogger: logger,
    })

    expect(published).toBe(false)
  })

  it('resolves completion reactions and applies approved lock only for approvals', () => {
    const logger = createLoggerStub()
    const approvedLockedPullRequests = new Set<string>()

    expect(resolveReviewCompletionReaction('APPROVE')).toBe('hooray')
    expect(resolveReviewCompletionReaction('REQUEST_CHANGES')).toBe('confused')

    applyApprovedLock({
      approvedLockEnabled: true,
      approvedLockedPullRequests,
      context: createPullRequestContext(),
      reviewEvent: 'APPROVE',
      runLogger: logger,
    })

    expect(approvedLockedPullRequests.has('acme/repo#42')).toBe(true)

    const notApplied = new Set<string>()
    applyApprovedLock({
      approvedLockEnabled: true,
      approvedLockedPullRequests: notApplied,
      context: createPullRequestContext(),
      reviewEvent: 'REQUEST_CHANGES',
      runLogger: logger,
    })
    expect(notApplied.size).toBe(0)
  })
})
