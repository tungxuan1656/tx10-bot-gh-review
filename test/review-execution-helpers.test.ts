import { describe, expect, it, vi } from 'vitest'

import type { AppLogger } from '../src/logger.js'
import {
  checkPublishedReviewMarker,
  createActiveRun,
} from '../src/review/review-execution-helpers.js'
import type { PullRequestContext, ReviewPlatform } from '../src/review/types.js'

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

describe('review execution helpers', () => {
  it('creates a fresh active run with cancellation defaults', () => {
    const run = createActiveRun({
      context: createPullRequestContext(),
      pullRequestKey: 'acme/repo#42',
      runKey: 'acme/repo#42@abc123',
    })

    expect(run.abortController.signal.aborted).toBe(false)
    expect(run.cancellationLogged).toBe(false)
    expect(run.cancellationReason).toBeNull()
    expect(run.runKey).toBe('acme/repo#42@abc123')
  })

  it('treats idempotency 404 lookup as not-published and logs a warning', async () => {
    const logger = createLoggerStub()
    const github = {
      hasPublishedResult: vi.fn().mockRejectedValue({ status: 404 }),
    } as unknown as ReviewPlatform

    const result = await checkPublishedReviewMarker({
      context: createPullRequestContext(),
      getErrorStatusCode: (error) =>
        typeof error === 'object' && error && 'status' in error
          ? Number((error as { status: number }).status)
          : null,
      github,
      marker: 'marker',
      runLogger: logger,
    })

    expect(result).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'review.idempotency_checked',
        reason: 'marker_not_found',
      }),
      'Review idempotency marker missing',
    )
  })

  it('rethrows non-404 idempotency failures', async () => {
    const logger = createLoggerStub()
    const github = {
      hasPublishedResult: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as ReviewPlatform

    await expect(
      checkPublishedReviewMarker({
        context: createPullRequestContext(),
        getErrorStatusCode: () => 500,
        github,
        marker: 'marker',
        runLogger: logger,
      }),
    ).rejects.toThrow('boom')
  })
})
