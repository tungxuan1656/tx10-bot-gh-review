import { describe, expect, it, vi } from 'vitest'

import { ReviewService } from '../src/review/service.js'
import type { CodexRunner } from '../src/review/codex.js'
import type { ReviewPlatform } from '../src/review/github-platform.js'
import type { AppLogger } from '../src/logger.js'
import type { NormalizedPullRequestEvent } from '../src/review/webhook-event.js'
import type {
  PRInfoObject,
  PriorSuccessfulReviewInfo,
  ReviewResult,
} from '../src/review/types.js'
import type {
  ReviewWorkspaceManager,
  WorkspacePrepareOptions,
} from '../src/review/workspace.js'

type PublishReviewInput = Parameters<ReviewPlatform['publishReview']>[0]

function createLoggerStub(): AppLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as AppLogger
}

function createPullRequestEvent(
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
    title: 'Add a review flow',
    headRef: 'feature/review-flow',
    headCloneUrl: 'https://github.com/acme/repo.git',
    baseRef: 'main',
    baseCloneUrl: 'https://github.com/acme/repo.git',
    ...overrides,
  }
}

function createPRInfoStub(): PRInfoObject {
  return {
    owner: 'acme',
    repo: 'repo',
    pullNumber: 42,
    title: 'Add a review flow',
    description: '',
    headSha: 'abc123',
    baseSha: 'def456',
    headRef: 'feature/review-flow',
    baseRef: 'main',
    htmlUrl: 'https://github.com/acme/repo/pull/42',
    commits: [{ sha: 'abc123', message: 'Add review flow' }],
    changedFilePaths: ['src/app.ts'],
  }
}

function createReviewResult(
  overrides: Partial<ReviewResult> = {},
): ReviewResult {
  return {
    summary: 'No issues.',
    changesOverview: '',
    score: 9,
    decision: 'approve',
    findings: [],
    ...overrides,
  }
}

function createPriorReviewInfo(
  overrides: Partial<PriorSuccessfulReviewInfo> = {},
): PriorSuccessfulReviewInfo {
  return {
    hasPriorSuccessfulReview: false,
    latestReviewedSha: null,
    latestReviewState: null,
    ...overrides,
  }
}

function createGitHubPlatform(overrides: Partial<ReviewPlatform> = {}) {
  const seenMarkers = new Set<string>()
  const hasPublishedResult = vi.fn((_context: unknown, marker: string) =>
    Promise.resolve(seenMarkers.has(marker)),
  )
  const setPullRequestReaction = vi.fn(() => Promise.resolve())
  const publishReview = vi.fn((input: PublishReviewInput) => {
    const marker = input.body.split('\n')[0]
    if (marker) {
      seenMarkers.add(marker)
    }

    return Promise.resolve()
  })
  const publishFailureComment = vi.fn((_context: unknown, body: string) => {
    const marker = body.split('\n')[0]
    if (marker) {
      seenMarkers.add(marker)
    }

    return Promise.resolve()
  })

  const baseMocks = {
    getPullRequestDiscussionMarkdown: vi
      .fn()
      .mockResolvedValue('# Pull Request Discussion Context\n\n- None\n'),
    getPriorSuccessfulReview: vi
      .fn()
      .mockResolvedValue(createPriorReviewInfo()),
    getPRInfo: vi.fn().mockResolvedValue(createPRInfoStub()),
    hasPublishedResult,
    publishFailureComment,
    publishReview,
    setPullRequestReaction,
    getFileContent: vi.fn(),
    listPullRequestFiles: vi.fn(),
  }

  const mocks = {
    ...baseMocks,
    ...overrides,
  }

  return {
    mocks,
    platform: mocks satisfies ReviewPlatform,
  }
}

function createWorkspaceManager(
  overrides: {
    availableRevisionRefs?: string[]
    prepareWorkspace?: ReviewWorkspaceManager['prepareWorkspace']
  } = {},
): {
  manager: ReviewWorkspaceManager
  mocks: {
    cleanup: ReturnType<typeof vi.fn>
    prepareWorkspace: ReturnType<typeof vi.fn>
  }
} {
  const cleanup = vi.fn().mockResolvedValue(undefined)
  const prepareWorkspaceMock = vi.fn(
    overrides.prepareWorkspace ??
      (() =>
        Promise.resolve({
          availableRevisionRefs: overrides.availableRevisionRefs ?? [
            'refs/codex-review/base',
            'refs/codex-review/head',
            'refs/codex-review/previous',
          ],
          cleanup,
          diff: [
            'diff --git a/src/app.ts b/src/app.ts',
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '@@ -1 +1 @@',
            "-console.log('a')",
            "+console.log('b')",
          ].join('\n'),
          prInfo: createPRInfoStub(),
          reviewableFiles: [
            {
              path: 'src/app.ts',
              patch: "@@ -1 +1 @@\n-console.log('a')\n+console.log('b')",
              content: "console.log('b');\n",
            },
          ],
          workingDirectory: '/tmp/codex-review-workspace',
        })),
  )

  const manager: ReviewWorkspaceManager = {
    prepareWorkspace(
      context,
      prInfo,
      loggerOverride,
      options?: WorkspacePrepareOptions,
    ) {
      return prepareWorkspaceMock(context, prInfo, loggerOverride, options)
    },
  }

  return {
    manager,
    mocks: {
      cleanup,
      prepareWorkspace: prepareWorkspaceMock,
    },
  }
}

function makeCodexRunner(input?: {
  review?: CodexRunner['review']
  reviewTwoPhase?: CodexRunner['reviewTwoPhase']
}): CodexRunner {
  return {
    review:
      input?.review ??
      (vi.fn().mockResolvedValue({
        ok: true,
        result: createReviewResult(),
      }) as CodexRunner['review']),
    reviewTwoPhase:
      input?.reviewTwoPhase ??
      (vi.fn().mockResolvedValue({
        ok: true,
        result: createReviewResult(),
      }) as CodexRunner['reviewTwoPhase']),
  }
}

describe('ReviewService', () => {
  it('uses two-phase codex flow for initial review requests', async () => {
    const github = createGitHubPlatform({
      getPriorSuccessfulReview: vi
        .fn()
        .mockResolvedValue(
          createPriorReviewInfo({ hasPriorSuccessfulReview: false }),
        ),
    })
    const workspace = createWorkspaceManager()
    const review = vi.fn().mockResolvedValue({
      ok: true,
      result: createReviewResult(),
    })
    const reviewTwoPhase = vi.fn().mockResolvedValue({
      ok: true,
      result: createReviewResult(),
    })
    const codex = makeCodexRunner({
      review: review as unknown as CodexRunner['review'],
      reviewTwoPhase: reviewTwoPhase as unknown as CodexRunner['reviewTwoPhase'],
    })

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
      {
        approvedLockEnabled: false,
      },
    )

    await service.handlePullRequestEvent(createPullRequestEvent())

    expect(reviewTwoPhase).toHaveBeenCalledTimes(1)
    expect(review).not.toHaveBeenCalled()
    expect(github.mocks.publishReview).toHaveBeenCalledTimes(1)
    expect(github.mocks.setPullRequestReaction).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      'eyes',
    )
    expect(github.mocks.setPullRequestReaction).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      'hooray',
    )
  })

  it('uses fast single-phase re-review flow after a prior successful bot review', async () => {
    const github = createGitHubPlatform({
      getPriorSuccessfulReview: vi.fn().mockResolvedValue(
        createPriorReviewInfo({
          hasPriorSuccessfulReview: true,
          latestReviewedSha: 'sha-prev',
          latestReviewState: 'CHANGES_REQUESTED',
        }),
      ),
    })
    const workspace = createWorkspaceManager()

    const review = vi.fn().mockResolvedValue({
      ok: true,
      result: createReviewResult(),
    })
    const reviewTwoPhase = vi.fn().mockResolvedValue({
      ok: true,
      result: createReviewResult(),
    })

    const codex = makeCodexRunner({
      review: review as unknown as CodexRunner['review'],
      reviewTwoPhase: reviewTwoPhase as unknown as CodexRunner['reviewTwoPhase'],
    })

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
      {
        approvedLockEnabled: false,
      },
    )

    await service.handlePullRequestEvent(
      createPullRequestEvent({ deliveryId: 'delivery-re-review' }),
    )

    expect(reviewTwoPhase).not.toHaveBeenCalled()
    expect(review).toHaveBeenCalledTimes(1)

    const reviewInput = review.mock.calls[0]?.[0] as {
      prompt: string
    }
    expect(reviewInput.prompt).toContain(
      'Delta range: refs/codex-review/previous..refs/codex-review/head',
    )
  })

  it('falls back to full PR range when previous reviewed SHA is unavailable in workspace', async () => {
    const github = createGitHubPlatform({
      getPriorSuccessfulReview: vi.fn().mockResolvedValue(
        createPriorReviewInfo({
          hasPriorSuccessfulReview: true,
          latestReviewedSha: 'sha-prev',
          latestReviewState: 'APPROVED',
        }),
      ),
    })
    const workspace = createWorkspaceManager({
      availableRevisionRefs: [
        'refs/codex-review/base',
        'refs/codex-review/head',
      ],
    })

    const review = vi.fn().mockResolvedValue({
      ok: true,
      result: createReviewResult(),
    })

    const codex = makeCodexRunner({
      review: review as unknown as CodexRunner['review'],
    })

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
      {
        approvedLockEnabled: false,
      },
    )

    await service.handlePullRequestEvent(
      createPullRequestEvent({ deliveryId: 'delivery-fallback' }),
    )

    const reviewInput = review.mock.calls[0]?.[0] as {
      prompt: string
    }
    expect(reviewInput.prompt).toContain(
      'Delta range: refs/codex-review/base..refs/codex-review/head',
    )
    expect(reviewInput.prompt).toContain(
      'Delta fallback applied: previous_review_sha_not_fetchable',
    )
  })

  it('ignores synchronize events entirely', async () => {
    const github = createGitHubPlatform()
    const workspace = createWorkspaceManager()
    const review = vi.fn().mockResolvedValue({
      ok: true,
      result: createReviewResult(),
    })
    const reviewTwoPhase = vi.fn().mockResolvedValue({
      ok: true,
      result: createReviewResult(),
    })
    const codex = makeCodexRunner({
      review: review as unknown as CodexRunner['review'],
      reviewTwoPhase: reviewTwoPhase as unknown as CodexRunner['reviewTwoPhase'],
    })
    const logger = createLoggerStub()

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      logger,
      'review-bot',
    )

    await service.handlePullRequestEvent(
      createPullRequestEvent({
        action: 'synchronize',
        actionKind: 'synchronize',
        requestedReviewerLogin: null,
      }),
    )

    expect(workspace.mocks.prepareWorkspace).not.toHaveBeenCalled()
    expect(reviewTwoPhase).not.toHaveBeenCalled()
    expect(review).not.toHaveBeenCalled()
    expect(github.mocks.publishReview).not.toHaveBeenCalled()
    expect(github.mocks.setPullRequestReaction).toHaveBeenCalledTimes(1)
    expect(github.mocks.setPullRequestReaction).toHaveBeenCalledWith(
      expect.any(Object),
      'laugh',
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'webhook.routed',
        reason: 'synchronize_ignored',
        status: 'ignored',
      }),
      'Webhook routed',
    )
  })

  it('ignores subsequent requests after approve with approved reason', async () => {
    const getPriorSuccessfulReview = vi
      .fn()
      .mockResolvedValueOnce(
        createPriorReviewInfo({
          hasPriorSuccessfulReview: false,
          latestReviewedSha: null,
          latestReviewState: null,
        }),
      )
      .mockResolvedValueOnce(
        createPriorReviewInfo({
          hasPriorSuccessfulReview: false,
          latestReviewedSha: null,
          latestReviewState: null,
        }),
      )
      .mockResolvedValueOnce(
        createPriorReviewInfo({
          hasPriorSuccessfulReview: true,
          latestReviewedSha: 'abc123',
          latestReviewState: 'APPROVED',
        }),
      )

    const github = createGitHubPlatform({
      getPriorSuccessfulReview,
    })
    const workspace = createWorkspaceManager()

    const reviewTwoPhase = vi.fn().mockResolvedValue({
      ok: true,
      result: createReviewResult({ decision: 'approve' }),
    })

    const review = vi.fn().mockResolvedValue({
      ok: true,
      result: createReviewResult({ decision: 'approve' }),
    })

    const codex = makeCodexRunner({
      review: review as unknown as CodexRunner['review'],
      reviewTwoPhase: reviewTwoPhase as unknown as CodexRunner['reviewTwoPhase'],
    })

    const logger = createLoggerStub()

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      logger,
      'review-bot',
      {
        approvedLockEnabled: true,
      },
    )

    await service.handlePullRequestEvent(
      createPullRequestEvent({ deliveryId: 'delivery-1' }),
    )
    await service.handlePullRequestEvent(
      createPullRequestEvent({ deliveryId: 'delivery-2' }),
    )

    expect(reviewTwoPhase).toHaveBeenCalledTimes(1)
    expect(review).not.toHaveBeenCalled()
    expect(github.mocks.publishReview).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'webhook.routed',
        reason: 'approved_before',
        status: 'ignored',
      }),
      'Webhook routed',
    )
  })

  it('keeps classifying as initial review when first run failed to publish successful review', async () => {
    const getPriorSuccessfulReview = vi.fn().mockResolvedValue(
      createPriorReviewInfo(),
    )

    const reviewTwoPhase = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        reason: 'Codex returned a non-zero exit code.',
      })
      .mockResolvedValueOnce({
        ok: true,
        result: createReviewResult(),
      })
    const review = vi.fn().mockResolvedValue({
      ok: true,
      result: createReviewResult(),
    })

    const github = createGitHubPlatform({
      getPriorSuccessfulReview,
    })
    const workspace = createWorkspaceManager()
    const codex = makeCodexRunner({
      review: review as unknown as CodexRunner['review'],
      reviewTwoPhase: reviewTwoPhase as unknown as CodexRunner['reviewTwoPhase'],
    })

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
    )

    await service.handlePullRequestEvent(
      createPullRequestEvent({ deliveryId: 'delivery-fail-1' }),
    )
    await service.handlePullRequestEvent(
      createPullRequestEvent({ deliveryId: 'delivery-fail-2' }),
    )

    expect(reviewTwoPhase).toHaveBeenCalledTimes(2)
    expect(review).not.toHaveBeenCalled()
    expect(github.mocks.publishFailureComment).toHaveBeenCalledTimes(1)
    expect(github.mocks.publishReview).toHaveBeenCalledTimes(1)
  })

  it('ignores trigger review after restart when prior successful review is approved', async () => {
    const getPriorSuccessfulReview = vi.fn().mockResolvedValue(
      createPriorReviewInfo({
        hasPriorSuccessfulReview: true,
        latestReviewedSha: 'abc123',
        latestReviewState: 'APPROVED',
      }),
    )

    const github = createGitHubPlatform({
      getPriorSuccessfulReview,
    })
    const workspace = createWorkspaceManager()
    const review = vi.fn().mockResolvedValue({
      ok: true,
      result: createReviewResult(),
    })
    const reviewTwoPhase = vi.fn().mockResolvedValue({
      ok: true,
      result: createReviewResult(),
    })
    const codex = makeCodexRunner({
      review: review as unknown as CodexRunner['review'],
      reviewTwoPhase: reviewTwoPhase as unknown as CodexRunner['reviewTwoPhase'],
    })
    const logger = createLoggerStub()

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      logger,
      'review-bot',
      {
        approvedLockEnabled: true,
      },
    )

    await service.handlePullRequestEvent(
      createPullRequestEvent({ deliveryId: 'delivery-restart-approved-1' }),
    )

    expect(workspace.mocks.prepareWorkspace).not.toHaveBeenCalled()
    expect(reviewTwoPhase).not.toHaveBeenCalled()
    expect(review).not.toHaveBeenCalled()
    expect(github.mocks.publishReview).not.toHaveBeenCalled()
    expect(github.mocks.setPullRequestReaction).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'webhook.routed',
        reason: 'approved_before',
        status: 'ignored',
      }),
      'Webhook routed',
    )
  })

  it('allows manual re-request on same head SHA using run-token marker dedupe when approved lock is disabled', async () => {
    const getPriorSuccessfulReview = vi.fn().mockResolvedValue(
      createPriorReviewInfo({
        hasPriorSuccessfulReview: false,
      }),
    )

    const github = createGitHubPlatform({
      getPriorSuccessfulReview,
    })
    const workspace = createWorkspaceManager()
    const review = vi.fn().mockResolvedValue({
      ok: true,
      result: createReviewResult(),
    })
    const reviewTwoPhase = vi.fn().mockResolvedValue({
      ok: true,
      result: createReviewResult(),
    })
    const codex = makeCodexRunner({
      review: review as unknown as CodexRunner['review'],
      reviewTwoPhase: reviewTwoPhase as unknown as CodexRunner['reviewTwoPhase'],
    })

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
      {
        approvedLockEnabled: false,
      },
    )

    await service.handlePullRequestEvent(
      createPullRequestEvent({ deliveryId: 'delivery-same-sha-1' }),
    )
    await service.handlePullRequestEvent(
      createPullRequestEvent({ deliveryId: 'delivery-same-sha-2' }),
    )

    expect(github.mocks.hasPublishedResult).toHaveBeenCalledTimes(2)
    const firstMarker = vi.mocked(github.mocks.hasPublishedResult).mock
      .calls[0]?.[1]
    const secondMarker = vi.mocked(github.mocks.hasPublishedResult).mock
      .calls[1]?.[1]
    expect(firstMarker).not.toEqual(secondMarker)
    expect(github.mocks.publishReview).toHaveBeenCalledTimes(2)
  })

  it('updates the final reaction to confused when review requests changes', async () => {
    const github = createGitHubPlatform({
      getPriorSuccessfulReview: vi.fn().mockResolvedValue(
        createPriorReviewInfo({
          hasPriorSuccessfulReview: true,
          latestReviewedSha: 'sha-prev',
          latestReviewState: 'CHANGES_REQUESTED',
        }),
      ),
    })
    const workspace = createWorkspaceManager()
    const review = vi.fn().mockResolvedValue({
      ok: true,
      result: createReviewResult({
        decision: 'request_changes',
        findings: [
          {
            severity: 'major',
            path: 'src/app.ts',
            line: 1,
            title: 'Needs fix',
            comment: 'Please address this issue.',
          },
        ],
      }),
    })

    const codex = makeCodexRunner({
      review: review as unknown as CodexRunner['review'],
    })

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
      {
        approvedLockEnabled: false,
      },
    )

    await service.handlePullRequestEvent(
      createPullRequestEvent({ deliveryId: 'delivery-request-changes' }),
    )

    expect(github.mocks.setPullRequestReaction).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      'eyes',
    )
    expect(github.mocks.setPullRequestReaction).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      'confused',
    )
  })

  it('falls back to a top-level review when inline comment locations are invalid', async () => {
    const github = createGitHubPlatform({
      publishReview: vi
        .fn()
        .mockRejectedValueOnce({
          status: 422,
          message: 'Validation Failed: review comments is invalid',
        })
        .mockResolvedValueOnce(undefined),
      getPriorSuccessfulReview: vi.fn().mockResolvedValue(
        createPriorReviewInfo({
          hasPriorSuccessfulReview: true,
          latestReviewedSha: 'sha-prev',
          latestReviewState: 'CHANGES_REQUESTED',
        }),
      ),
    })
    const workspace = createWorkspaceManager()
    const review = vi.fn().mockResolvedValue({
      ok: true,
      result: createReviewResult({
        findings: [
          {
            severity: 'minor',
            path: 'src/app.ts',
            line: 1,
            title: 'Invalid line',
            comment: 'This should not be renderable inline.',
          },
        ],
      }),
    })

    const codex = makeCodexRunner({
      review: review as unknown as CodexRunner['review'],
    })

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
      {
        approvedLockEnabled: false,
      },
    )

    await service.handlePullRequestEvent(
      createPullRequestEvent({ deliveryId: 'delivery-inline-fallback' }),
    )

    expect(github.mocks.publishReview).toHaveBeenCalledTimes(2)
    const firstPublish = vi.mocked(github.mocks.publishReview).mock.calls[0]?.[0]
    const secondPublish =
      vi.mocked(github.mocks.publishReview).mock.calls[1]?.[0]

    expect(firstPublish?.comments).toHaveLength(1)
    expect(secondPublish?.comments).toHaveLength(0)
    expect(secondPublish?.body).toContain('Additional findings')
  })

})
