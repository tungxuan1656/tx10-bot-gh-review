import { describe, expect, it, vi } from 'vitest'

import type { AppLogger } from '../src/logger.js'
import {
  buildAdditionalRevisions,
  runReviewWorkflow,
} from '../src/review/review-workflow.js'
import type { CodexRunner } from '../src/review/codex.js'
import type { ReviewPlatform } from '../src/review/github-platform.js'
import type { ActiveRun, ReviewQueueManager } from '../src/review/review-queue.js'
import type { PreparedReviewWorkspace } from '../src/review/workspace.js'
import type { PullRequestContext, ReviewableFile } from '../src/review/types.js'

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

function createWorkspace(
  reviewableFiles: ReviewableFile[],
): PreparedReviewWorkspace {
  return {
    availableRevisionRefs: [
      'refs/codex-review/base',
      'refs/codex-review/head',
      'refs/codex-review/previous',
    ],
    cleanup: vi.fn().mockResolvedValue(undefined),
    diff: '',
    prInfo: {
      owner: 'acme',
      repo: 'repo',
      pullNumber: 42,
      title: 'Add review flow',
      description: '',
      headSha: 'abc123',
      baseSha: 'def456',
      headRef: 'feature/review-flow',
      baseRef: 'main',
      htmlUrl: 'https://github.com/acme/repo/pull/42',
      commits: [{ sha: 'abc123', message: 'Add review flow' }],
      changedFilePaths: reviewableFiles.map((file) => file.path),
    },
    reviewableFiles,
    workingDirectory: '/tmp/codex-review-workspace',
  }
}

function createQueueManager(
  shouldStopForCancellation = false,
): ReviewQueueManager {
  return {
    shouldStopForCancellation: vi.fn(() => shouldStopForCancellation),
  } as unknown as ReviewQueueManager
}

function createCodexRunner(): {
  codex: CodexRunner
  review: ReturnType<typeof vi.fn>
  reviewTwoPhase: ReturnType<typeof vi.fn>
} {
  const success = {
    ok: true,
    result: {
      summary: 'Looks good.',
      changesOverview: '',
      score: 9,
      decision: 'approve' as const,
      findings: [],
    },
  }

  const review = vi.fn().mockResolvedValue(success)
  const reviewTwoPhase = vi.fn().mockResolvedValue(success)

  return {
    codex: {
      review,
      reviewTwoPhase,
    },
    review,
    reviewTwoPhase,
  }
}

function createReviewPlatform() {
  const setPullRequestReaction = vi.fn(() => Promise.resolve())
  const publishReview = vi.fn(() => Promise.resolve())

  return {
    platform: {
      publishReview,
      setPullRequestReaction,
    } as unknown as ReviewPlatform,
    publishReview,
    setPullRequestReaction,
  }
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

describe('review workflow', () => {
  it('builds additional revisions only for re-review of a prior SHA', () => {
    expect(
      buildAdditionalRevisions({
        currentHeadSha: 'abc123',
        headRef: 'feature/review-flow',
        latestReviewedSha: null,
        reviewMode: 'initial_review',
      }),
    ).toEqual([])

    expect(
      buildAdditionalRevisions({
        currentHeadSha: 'abc123',
        headRef: 'feature/review-flow',
        latestReviewedSha: 'oldsha',
        reviewMode: 're_review',
      }),
    ).toEqual([
      {
        revision: 'oldsha',
        fallbackRef: 'feature/review-flow',
        localRef: 'refs/codex-review/previous',
        remote: 'head',
      },
    ])
  })

  it('short-circuits when no reviewable files exist', async () => {
    const logger = createLoggerStub()
    const { codex, review, reviewTwoPhase } = createCodexRunner()
    const { platform, setPullRequestReaction } = createReviewPlatform()
    const workspace = createWorkspace([])

    const result = await runReviewWorkflow({
      approvedLockEnabled: true,
      approvedLockedPullRequests: new Set<string>(),
      codex,
      context: createPullRequestContext(),
      deliveryId: 'delivery-123',
      github: platform,
      priorSuccessfulReview: {
        hasPriorSuccessfulReview: false,
        latestReviewedSha: null,
        latestReviewState: null,
      },
      queueManager: createQueueManager(false),
      reviewMode: 'initial_review',
      run: createRun(),
      runLogger: logger,
      workspace,
    })

    expect(result).toBe(false)
    expect(reviewTwoPhase).not.toHaveBeenCalled()
    expect(review).not.toHaveBeenCalled()
    expect(setPullRequestReaction).toHaveBeenCalledWith(
      createPullRequestContext(),
      'laugh',
    )
  })

  it('runs the initial review path and publishes a review', async () => {
    const logger = createLoggerStub()
    const { codex, review, reviewTwoPhase } = createCodexRunner()
    const { platform, publishReview, setPullRequestReaction } =
      createReviewPlatform()
    const workspace = createWorkspace([
      {
        path: 'src/app.ts',
        patch: '@@ -1 +1 @@\n-console.log("a")\n+console.log("b")',
        content: 'console.log("b")\n',
      },
    ])
    const approvedLockedPullRequests = new Set<string>()

    const result = await runReviewWorkflow({
      approvedLockEnabled: true,
      approvedLockedPullRequests,
      codex,
      context: createPullRequestContext(),
      deliveryId: 'delivery-123',
      github: platform,
      priorSuccessfulReview: {
        hasPriorSuccessfulReview: false,
        latestReviewedSha: null,
        latestReviewState: null,
      },
      queueManager: createQueueManager(false),
      reviewMode: 'initial_review',
      run: createRun(),
      runLogger: logger,
      workspace,
    })

    expect(result).toBe(true)
    expect(reviewTwoPhase).toHaveBeenCalledTimes(1)
    expect(review).not.toHaveBeenCalled()
    expect(publishReview).toHaveBeenCalledTimes(1)
    expect(setPullRequestReaction).toHaveBeenCalledWith(
      createPullRequestContext(),
      'hooray',
    )
    expect(approvedLockedPullRequests.has('acme/repo#42')).toBe(true)
  })
})
