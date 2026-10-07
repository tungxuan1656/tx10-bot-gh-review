import { describe, expect, it, vi } from 'vitest'

import type { AppLogger } from '../src/logger.js'
import {
  checkPublishedReviewMarker,
  createActiveRun,
  prepareWorkspaceAndDiscussion,
} from '../src/review/review-execution-helpers.js'
import type { NormalizedPullRequestEvent, PullRequestContext, ReviewPlatform } from '../src/review/types.js'

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

  it('cleans up when persisting discussion context fails', async () => {
    const context = createPullRequestContext()
    const cleanup = vi.fn().mockResolvedValue(undefined)
    const workspace = { availableRevisionRefs: [], cleanup, diff: '', prInfo: { ...context, description: '', commits: [], changedFilePaths: [] }, reviewableFiles: [], workingDirectory: '/tmp/workspace' }

    await expect(prepareWorkspaceAndDiscussion({
      context,
      discussionCacheOptions: {},
      event: { ...context, deliveryId: 'delivery', eventName: 'pull_request', actionKind: 'review_requested', senderLogin: 'author', requestedReviewerLogin: 'review-bot', requestedReviewerLogins: ['review-bot'], beforeSha: null, afterSha: null, botStillRequested: null } satisfies NormalizedPullRequestEvent,
      github: { getPullRequestDiscussionMarkdown: vi.fn().mockResolvedValue('discussion') } as unknown as ReviewPlatform,
      persistDiscussionContext: vi.fn().mockRejectedValue(new Error('disk full')),
      prInfo: workspace.prInfo,
      priorSuccessfulReview: { hasPriorSuccessfulReview: false, latestReviewedSha: null, latestReviewState: null },
      reviewMode: 'initial_review',
      run: createActiveRun({ context, runKey: 'run', pullRequestKey: 'pr' }),
      runLogger: createLoggerStub(),
      shouldStopForCancellation: () => false,
      workspaceManager: { prepareWorkspace: vi.fn().mockResolvedValue(workspace) },
    })).rejects.toThrow('disk full')
    expect(cleanup).toHaveBeenCalledOnce()
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
