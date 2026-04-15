import { describe, expect, it, vi } from 'vitest'

import { ReviewService } from '../src/review/service.js'
import type { CodexRunner } from '../src/review/codex.js'
import type { ReviewPlatform } from '../src/review/github-platform.js'
import type { AppLogger } from '../src/logger.js'
import type { NormalizedPullRequestEvent } from '../src/review/webhook-event.js'
import type { PRInfoObject } from '../src/review/types.js'
import type { ReviewWorkspaceManager } from '../src/review/workspace.js'

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

function createGitHubPlatform(overrides: Partial<ReviewPlatform> = {}) {
  const baseMocks = {
    getPullRequestDiscussionMarkdown: vi
      .fn()
      .mockResolvedValue('# Pull Request Discussion Context\n\n- None\n'),
    getPRInfo: vi.fn().mockResolvedValue(createPRInfoStub()),
    hasPublishedResult: vi.fn().mockResolvedValue(false),
    publishFailureComment: vi.fn().mockResolvedValue(undefined),
    publishReview: vi.fn().mockResolvedValue(undefined),
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
  overrides: Partial<ReviewWorkspaceManager> = {},
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
  const mocks: {
    cleanup: ReturnType<typeof vi.fn>
    prepareWorkspace: ReturnType<typeof vi.fn>
  } = {
    cleanup,
    prepareWorkspace: prepareWorkspaceMock,
  }
  const manager: ReviewWorkspaceManager = {
    prepareWorkspace(context, prInfo, loggerOverride) {
      return prepareWorkspaceMock(context, prInfo, loggerOverride)
    },
  }

  return {
    manager,
    mocks,
  }
}

function createSuccessfulCodexReview(): CodexRunner['reviewChained'] {
  return vi.fn(() =>
    Promise.resolve({
      ok: true,
      result: {
        summary: 'Found one issue.',
        score: 6,
        decision: 'request_changes',
        findings: [
          {
            severity: 'major',
            path: 'src/app.ts',
            line: 1,
            title: 'Console statement committed',
            comment: 'Use the structured logger instead.',
          },
        ],
      },
    }),
  ) as CodexRunner['reviewChained']
}

function makeCodexRunner(
  reviewChained: CodexRunner['reviewChained'],
): CodexRunner {
  return {
    review: vi.fn(),
    reviewChained,
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })

  return { promise, reject, resolve }
}

describe('ReviewService', () => {
  it('publishes a review for a valid Codex result', async () => {
    const github = createGitHubPlatform()
    const workspace = createWorkspaceManager()
    const codex = makeCodexRunner(createSuccessfulCodexReview())

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
    )
    await service.handlePullRequestEvent(createPullRequestEvent())

    expect(github.mocks.publishReview).toHaveBeenCalledTimes(1)
    expect(github.mocks.publishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'REQUEST_CHANGES',
      }),
    )
    expect(github.mocks.publishFailureComment).not.toHaveBeenCalled()
    expect(workspace.mocks.cleanup).toHaveBeenCalledTimes(1)
  })

  it('emits lifecycle logs for a successful review run', async () => {
    const github = createGitHubPlatform()
    const workspace = createWorkspaceManager()
    const codexRunner = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        summary: 'No issues.',
        score: 9,
        decision: 'approve',
        findings: [],
      },
    }) as CodexRunner['reviewChained']
    const codex: CodexRunner = makeCodexRunner(codexRunner)
    const logger = createLoggerStub()

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      logger,
      'review-bot',
    )
    await service.handlePullRequestEvent(createPullRequestEvent())

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'review_requested',
        deliveryId: 'delivery-123',
        event: 'webhook.routed',
        headSha: 'abc123',
        owner: 'acme',
        pullNumber: 42,
        repo: 'repo',
        status: 'trigger_review',
      }),
      'Webhook routed',
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: 'delivery-123',
        event: 'review.started',
        runKey: 'acme/repo#42@abc123',
        status: 'started',
      }),
      'Review started',
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: 'delivery-123',
        event: 'review.completed',
        runKey: 'acme/repo#42@abc123',
        status: 'completed',
      }),
      'Review completed',
    )
  })

  it('publishes a neutral failure comment when Codex fails', async () => {
    const github = createGitHubPlatform()
    const workspace = createWorkspaceManager()
    const codex: CodexRunner = makeCodexRunner(
      vi.fn().mockResolvedValue({
        ok: false,
        reason: 'Codex returned a non-zero exit code.',
      }) as CodexRunner['reviewChained'],
    )

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
    )
    await service.handlePullRequestEvent(createPullRequestEvent())

    expect(github.mocks.publishReview).not.toHaveBeenCalled()
    expect(github.mocks.publishFailureComment).toHaveBeenCalledTimes(1)
  })

  it('skips duplicate head SHA results', async () => {
    const github = createGitHubPlatform({
      hasPublishedResult: vi.fn().mockResolvedValue(true),
    })
    const workspace = createWorkspaceManager()
    const reviewChained = vi.fn()
    const codex = makeCodexRunner(reviewChained)

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
    )
    await service.handlePullRequestEvent(createPullRequestEvent())

    expect(workspace.mocks.prepareWorkspace).not.toHaveBeenCalled()
    expect(reviewChained).not.toHaveBeenCalled()
  })

  it('continues review when idempotency check returns not found', async () => {
    const github = createGitHubPlatform({
      hasPublishedResult: vi.fn().mockRejectedValue({
        status: 404,
        message: 'Not Found',
      }),
    })
    const workspace = createWorkspaceManager()
    const reviewChained = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        summary: 'No actionable issues.',
        score: 9,
        decision: 'approve',
        findings: [],
      },
    }) as CodexRunner['reviewChained']
    const codex: CodexRunner = makeCodexRunner(reviewChained)

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
    )
    await service.handlePullRequestEvent(createPullRequestEvent())

    expect(workspace.mocks.prepareWorkspace).toHaveBeenCalledTimes(1)
    expect(reviewChained).toHaveBeenCalledTimes(1)
    expect(github.mocks.publishReview).toHaveBeenCalledTimes(1)
    expect(github.mocks.publishFailureComment).not.toHaveBeenCalled()
  })

  it('publishes neutral failure comment when idempotency check is forbidden', async () => {
    const github = createGitHubPlatform({
      hasPublishedResult: vi.fn().mockRejectedValue({
        status: 403,
        message: 'Forbidden',
      }),
    })
    const workspace = createWorkspaceManager()
    const reviewChained = vi.fn()
    const codex = makeCodexRunner(reviewChained as CodexRunner['reviewChained'])

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
    )
    await service.handlePullRequestEvent(createPullRequestEvent())

    expect(workspace.mocks.prepareWorkspace).not.toHaveBeenCalled()
    expect(reviewChained).not.toHaveBeenCalled()
    expect(github.mocks.publishReview).not.toHaveBeenCalled()
    expect(github.mocks.publishFailureComment).toHaveBeenCalledTimes(1)
  })

  it('does not throw when fallback failure comment publishing also fails', async () => {
    const github = createGitHubPlatform({
      hasPublishedResult: vi.fn().mockRejectedValue({
        status: 403,
        message: 'Forbidden',
      }),
      publishFailureComment: vi
        .fn()
        .mockRejectedValue(new Error('comment publish failed')),
    })
    const workspace = createWorkspaceManager()
    const reviewChained = vi.fn()
    const codex: CodexRunner = makeCodexRunner(
      reviewChained as CodexRunner['reviewChained'],
    )
    const logger = createLoggerStub()

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      logger,
      'review-bot',
    )

    await expect(
      service.handlePullRequestEvent(createPullRequestEvent()),
    ).resolves.toBeUndefined()

    expect(github.mocks.publishFailureComment).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledTimes(2)
  })

  it('passes the temporary workspace directory and unified diff to Codex', async () => {
    const github = createGitHubPlatform()
    const workspace = createWorkspaceManager()
    const reviewChained = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        summary: 'No actionable issues.',
        score: 9,
        decision: 'approve',
        findings: [],
      },
    })
    const codex: CodexRunner = makeCodexRunner(reviewChained)

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
    )
    await service.handlePullRequestEvent(createPullRequestEvent())

    const reviewInput = reviewChained.mock.calls[0]?.[0] as {
      phase1Prompt: string
      phase2Prompt: (phase1Output: string) => string
      phase3Prompt: (phase2Output: string) => string
      workingDirectory: string
    }
    expect(reviewChained).toHaveBeenCalledTimes(1)
    expect(reviewInput.workingDirectory).toBe('/tmp/codex-review-workspace')
    expect(reviewInput.phase1Prompt).toContain('pr-info.yaml')
    const phase2Prompt = reviewInput.phase2Prompt('phase1-summary')
    const phase3Prompt = reviewInput.phase3Prompt('phase2-overview')
    expect(phase2Prompt).toContain(
      "git diff --name-status refs/codex-review/base refs/codex-review/head -- 'src/app.ts'",
    )
    expect(phase2Prompt).toContain(
      "git diff --unified=5 refs/codex-review/base refs/codex-review/head -- 'src/app.ts' | head -c 80000",
    )
    expect(phase3Prompt).toContain(
      "git diff --name-status refs/codex-review/base refs/codex-review/head -- 'src/app.ts'",
    )
    expect(phase3Prompt).toContain(
      "git diff --unified=5 refs/codex-review/base refs/codex-review/head -- 'src/app.ts' | head -c 80000",
    )
    expect(github.mocks.publishReview).toHaveBeenCalledTimes(1)
    expect(github.mocks.publishFailureComment).not.toHaveBeenCalled()
  })

  it('processes review requests in global FIFO order across repositories', async () => {
    const github = createGitHubPlatform()
    const workspace = createWorkspaceManager()
    const firstReviewDeferred = createDeferred<{
      ok: true
      result: {
        decision: 'approve'
        findings: []
        score: number
        summary: string
      }
    }>()
    const reviewChained = vi
      .fn<CodexRunner['reviewChained']>()
      .mockImplementationOnce(() => firstReviewDeferred.promise)
      .mockResolvedValue({
        ok: true,
        result: {
          summary: 'No issues.',
          score: 9,
          decision: 'approve',
          findings: [],
        },
      })
    const codex: CodexRunner = makeCodexRunner(reviewChained)

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
    )

    const repoOneRequest = service.handlePullRequestEvent(
      createPullRequestEvent(),
    )
    await Promise.resolve()
    const repoTwoRequest = service.handlePullRequestEvent(
      createPullRequestEvent({
        deliveryId: 'delivery-456',
        headSha: 'def999',
        owner: 'acme-2',
        pullNumber: 7,
        repo: 'repo-2',
      }),
    )

    firstReviewDeferred.resolve({
      ok: true,
      result: {
        summary: 'No issues.',
        score: 9,
        decision: 'approve',
        findings: [],
      },
    })

    await Promise.all([repoOneRequest, repoTwoRequest])

    expect(reviewChained).toHaveBeenCalledTimes(2)
    const publishedHeads = vi
      .mocked(github.mocks.publishReview)
      .mock.calls.map((call) => (call[0] as PublishReviewInput).context.headSha)
    expect(publishedHeads).toEqual(['abc123', 'def999'])
  })

  it('cancels in-flight Codex run on synchronize and processes next queued request first', async () => {
    const github = createGitHubPlatform()
    const workspace = createWorkspaceManager()
    const firstRunStarted = createDeferred<void>()
    const firstRunCancelled = createDeferred<void>()
    const reviewChained = vi
      .fn<CodexRunner['reviewChained']>()
      .mockImplementationOnce((input) => {
        firstRunStarted.resolve()
        return new Promise((resolve) => {
          if (input.abortSignal?.aborted) {
            firstRunCancelled.resolve()
            resolve({
              ok: false,
              reason: 'Codex review canceled.',
              cancelled: true,
            })
            return
          }

          input.abortSignal?.addEventListener(
            'abort',
            () => {
              firstRunCancelled.resolve()
              resolve({
                ok: false,
                reason: 'Codex review canceled.',
                cancelled: true,
              })
            },
            { once: true },
          )
        })
      })
      .mockResolvedValue({
        ok: true,
        result: {
          summary: 'No issues.',
          score: 9,
          decision: 'approve',
          findings: [],
        },
      })
    const codex: CodexRunner = makeCodexRunner(reviewChained)

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
    )

    const repoOneOriginal = service.handlePullRequestEvent(
      createPullRequestEvent(),
    )
    await firstRunStarted.promise

    const repoTwoRequest = service.handlePullRequestEvent(
      createPullRequestEvent({
        deliveryId: 'delivery-456',
        headSha: 'sha-repo-2',
        owner: 'acme-2',
        pullNumber: 7,
        repo: 'repo-2',
      }),
    )

    const repoOneUpdated = service.handlePullRequestEvent(
      createPullRequestEvent({
        action: 'synchronize',
        actionKind: 'synchronize',
        afterSha: 'sha-repo-1-new',
        beforeSha: 'abc123',
        botStillRequested: true,
        headSha: 'sha-repo-1-new',
        requestedReviewerLogin: null,
        requestedReviewerLogins: ['review-bot'],
      }),
    )

    await firstRunCancelled.promise
    await Promise.all([repoOneOriginal, repoTwoRequest, repoOneUpdated])

    const publishedHeads = vi
      .mocked(github.mocks.publishReview)
      .mock.calls.map((call) => (call[0] as PublishReviewInput).context.headSha)
    expect(publishedHeads).toEqual(['sha-repo-2', 'sha-repo-1-new'])
    expect(publishedHeads).not.toContain('abc123')
  })

  it('skips synchronize commits after a PR is approved when approved lock is enabled', async () => {
    const github = createGitHubPlatform()
    const workspace = createWorkspaceManager()
    const reviewChained = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        summary: 'No issues.',
        score: 9,
        decision: 'approve',
        findings: [],
      },
    }) as CodexRunner['reviewChained']
    const codex: CodexRunner = makeCodexRunner(reviewChained)
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

    await service.handlePullRequestEvent(createPullRequestEvent())
    await service.handlePullRequestEvent(
      createPullRequestEvent({
        action: 'synchronize',
        actionKind: 'synchronize',
        afterSha: 'sha-after-approve',
        beforeSha: 'abc123',
        botStillRequested: true,
        headSha: 'sha-after-approve',
        requestedReviewerLogin: null,
        requestedReviewerLogins: ['review-bot'],
      }),
    )

    expect(reviewChained).toHaveBeenCalledTimes(1)
    expect(github.mocks.publishReview).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'review.queue_ignored',
        reason: 'approved_locked',
        status: 'ignored',
      }),
      'Review queued event ignored',
    )
  })

  it('publishes APPROVE with comments when findings are non-blocking', async () => {
    const github = createGitHubPlatform()
    const workspace = createWorkspaceManager()
    const codex: CodexRunner = makeCodexRunner(
      vi.fn().mockResolvedValue({
        ok: true,
        result: {
          summary: 'Minor follow-up recommended.',
          score: 8,
          decision: 'approve',
          findings: [
            {
              severity: 'minor',
              path: 'src/app.ts',
              line: 1,
              title: 'Small cleanup',
              comment: 'Prefer the shared logger helper here.',
            },
          ],
        },
      }) as CodexRunner['reviewChained'],
    )

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
    )
    await service.handlePullRequestEvent(createPullRequestEvent())

    const publishReviewMock = vi.mocked(github.mocks.publishReview)
    expect(publishReviewMock).toHaveBeenCalledTimes(1)
    const publishInput = publishReviewMock.mock.calls[0]?.[0] as {
      comments: Array<{ body: string }>
      event: string
    }
    expect(publishInput.event).toBe('APPROVE')
    expect(publishInput.comments).toHaveLength(1)
    expect(publishInput.comments[0]?.body).toContain('Small cleanup')
    expect(github.mocks.publishFailureComment).not.toHaveBeenCalled()
  })

  it('publishes a neutral failure comment when decision mismatches finding severity', async () => {
    const github = createGitHubPlatform()
    const workspace = createWorkspaceManager()
    const codex: CodexRunner = makeCodexRunner(
      vi.fn().mockResolvedValue({
        ok: true,
        result: {
          summary: 'Mismatch response.',
          score: 8,
          decision: 'approve',
          findings: [
            {
              severity: 'major',
              path: 'src/app.ts',
              line: 1,
              title: 'Missing validation',
              comment: 'This should block the review.',
            },
          ],
        },
      }) as CodexRunner['reviewChained'],
    )

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
    )
    await service.handlePullRequestEvent(createPullRequestEvent())

    expect(github.mocks.publishReview).not.toHaveBeenCalled()
    expect(github.mocks.publishFailureComment).toHaveBeenCalledTimes(1)
    expect(github.mocks.publishFailureComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(
        'Expected "request_changes" but received "approve".',
      ),
    )
  })

  it('retries with a body-only review when GitHub rejects inline comment locations', async () => {
    const publishReviewMock = vi
      .fn()
      .mockRejectedValueOnce({
        status: 422,
        message: 'Review comments is invalid.',
        errors: [
          {
            resource: 'PullRequestReviewComment',
            field: 'line',
            code: 'invalid',
          },
        ],
      })
      .mockResolvedValueOnce(undefined)
    const github = createGitHubPlatform({
      publishReview: publishReviewMock,
    })
    const workspace = createWorkspaceManager()
    const codex = makeCodexRunner(createSuccessfulCodexReview())

    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
    )
    await service.handlePullRequestEvent(createPullRequestEvent())

    const firstPublishInput = publishReviewMock.mock.calls[0]?.[0] as {
      body: string
      comments: unknown[]
    }
    const secondPublishInput = publishReviewMock.mock.calls[1]?.[0] as {
      body: string
      comments: unknown[]
    }

    expect(publishReviewMock).toHaveBeenCalledTimes(2)
    expect(firstPublishInput.comments).toHaveLength(1)
    expect(secondPublishInput.comments).toEqual([])
    expect(secondPublishInput.body).toContain('### Additional findings')
    expect(secondPublishInput.body).toContain('Console statement committed')
    expect(github.mocks.publishFailureComment).not.toHaveBeenCalled()
  })

  it('ignores review requests for a different reviewer', async () => {
    const github = createGitHubPlatform({})
    const workspace = createWorkspaceManager()
    const reviewChained = vi.fn()
    const codex: CodexRunner = makeCodexRunner(
      reviewChained as CodexRunner['reviewChained'],
    )
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
        requestedReviewerLogin: 'someone-else',
        requestedReviewerLogins: ['someone-else'],
      }),
    )

    expect(workspace.mocks.prepareWorkspace).not.toHaveBeenCalled()
    expect(reviewChained).not.toHaveBeenCalled()
    expect(github.mocks.publishReview).not.toHaveBeenCalled()
    expect(github.mocks.publishFailureComment).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'webhook.routed',
        reason: 'reviewer_mismatch',
        status: 'ignored',
      }),
      'Webhook routed',
    )
  })

  it('reviews synchronize events when the bot remains requested', async () => {
    const github = createGitHubPlatform({})
    const workspace = createWorkspaceManager()
    const reviewChained = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        summary: 'No actionable issues.',
        score: 9,
        decision: 'approve',
        findings: [],
      },
    }) as CodexRunner['reviewChained']
    const codex: CodexRunner = makeCodexRunner(reviewChained)
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
        afterSha: 'abc123',
        beforeSha: '000000',
        botStillRequested: true,
        requestedReviewerLogin: null,
      }),
    )

    expect(workspace.mocks.prepareWorkspace).toHaveBeenCalledTimes(1)
    expect(reviewChained).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        botStillRequested: true,
        event: 'webhook.routed',
        status: 'trigger_review',
      }),
      'Webhook routed',
    )
  })

  it('cancels an in-flight review after review_request_removed arrives', async () => {
    const hasPublishedResultDeferred = createDeferred<boolean>()
    const github = createGitHubPlatform({
      hasPublishedResult: vi
        .fn()
        .mockImplementation(() => hasPublishedResultDeferred.promise),
      publishReview: vi.fn(),
    })
    const workspace = createWorkspaceManager()
    const reviewChained = vi.fn()
    const codex: CodexRunner = makeCodexRunner(
      reviewChained as CodexRunner['reviewChained'],
    )
    const logger = createLoggerStub()
    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      logger,
      'review-bot',
    )

    const runPromise = service.handlePullRequestEvent(createPullRequestEvent())
    await Promise.resolve()

    await service.handlePullRequestEvent(
      createPullRequestEvent({
        action: 'review_request_removed',
        actionKind: 'review_request_removed',
        requestedReviewerLogins: [],
      }),
    )

    hasPublishedResultDeferred.resolve(false)
    await runPromise

    expect(workspace.mocks.prepareWorkspace).not.toHaveBeenCalled()
    expect(reviewChained).not.toHaveBeenCalled()
    expect(github.mocks.publishReview).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'review.cancel_requested',
        reason: 'cancel_requested',
        runKey: 'acme/repo#42@abc123',
        status: 'cancel_requested',
      }),
      'Review cancel requested',
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'review.canceled',
        reason: 'cancel_requested',
        runKey: 'acme/repo#42@abc123',
        status: 'canceled',
      }),
      'Review canceled',
    )
  })

  it('does not cancel an in-flight review when a delayed review_requested arrives for an older SHA', async () => {
    const publishReviewMock = vi.fn().mockResolvedValue(undefined)
    const github = createGitHubPlatform({ publishReview: publishReviewMock })
    const workspace = createWorkspaceManager()
    const runStarted = createDeferred<void>()
    const reviewChained = vi
      .fn<CodexRunner['reviewChained']>()
      .mockImplementationOnce(() => {
        runStarted.resolve()
        return Promise.resolve({
          ok: true,
          result: {
            summary: 'No issues.',
            score: 9,
            decision: 'approve',
            findings: [],
          },
        })
      })
    const codex = makeCodexRunner(reviewChained)
    const service = new ReviewService(
      github.platform,
      codex,
      workspace.manager,
      createLoggerStub(),
      'review-bot',
    )

    // Start the in-flight review for headSha 'abc123'
    const currentRun = service.handlePullRequestEvent(createPullRequestEvent())
    await runStarted.promise

    // Delayed/out-of-order review_requested arrives for an older SHA while abc123 is in-flight.
    // With the fix, latestHead must NOT be overwritten to 'old-sha-111' and the
    // in-flight run must NOT be cancelled.
    await Promise.all([
      currentRun,
      service.handlePullRequestEvent(
        createPullRequestEvent({ headSha: 'old-sha-111' }),
      ),
    ])

    // The in-flight 'abc123' review should have published successfully
    expect(publishReviewMock).toHaveBeenCalledTimes(1)
    expect(
      (publishReviewMock.mock.calls[0]?.[0] as PublishReviewInput).context
        .headSha,
    ).toBe('abc123')
    expect(github.mocks.publishFailureComment).not.toHaveBeenCalled()
  })

  it('ignores unsupported pull_request actions', async () => {
    const github = createGitHubPlatform({})
    const workspace = createWorkspaceManager()
    const reviewChained = vi.fn()
    const codex: CodexRunner = makeCodexRunner(
      reviewChained as CodexRunner['reviewChained'],
    )
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
        action: 'opened',
        actionKind: 'other_pull_request_action',
      }),
    )

    expect(workspace.mocks.prepareWorkspace).not.toHaveBeenCalled()
    expect(reviewChained).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'webhook.routed',
        reason: 'unsupported_action',
        status: 'ignored',
      }),
      'Webhook routed',
    )
  })
})
