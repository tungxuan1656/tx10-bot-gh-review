import { describe, expect, it, vi } from 'vitest'

import { buildReviewMarker } from '../src/review/summary.js'
import { createGitHubReviewPlatform } from '../src/review/github-platform.js'
import type { PullRequestContext } from '../src/review/types.js'

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

function createPlatformWithPublishedItems(input: {
  comments: Array<{ body?: string; user?: { login?: string } }>
  reviews: Array<{ body?: string; user?: { login?: string } }>
}) {
  const listFiles = vi.fn()
  const listReviews = vi.fn()
  const createReview = vi.fn()
  const listComments = vi.fn()
  const createComment = vi.fn()
  const getContent = vi.fn()
  const paginate = vi.fn((route: unknown) => {
    if (route === listReviews) {
      return Promise.resolve(input.reviews)
    }

    if (route === listComments) {
      return Promise.resolve(input.comments)
    }

    return Promise.resolve([])
  })

  const platform = createGitHubReviewPlatform(
    {
      githubToken: 'ghp_test_token',
      githubBotLogin: 'review-bot',
    },
    {
      createOctokit: () =>
        ({
          paginate,
          rest: {
            pulls: {
              listFiles,
              listReviews,
              createReview,
            },
            issues: {
              listComments,
              createComment,
            },
            repos: {
              getContent,
            },
          },
        }) as never,
    },
  )

  return { platform }
}

describe('createGitHubReviewPlatform', () => {
  it('ignores marker comments that were not authored by the configured bot login', async () => {
    const marker = buildReviewMarker('abc123')
    const { platform } = createPlatformWithPublishedItems({
      comments: [
        {
          body: `Human copied the marker ${marker}`,
          user: {
            login: 'teammate',
          },
        },
      ],
      reviews: [],
    })

    const result = await platform.hasPublishedResult(
      createPullRequestContext(),
      marker,
    )

    expect(result).toBe(false)
  })

  it('accepts marker comments authored by the configured bot login', async () => {
    const marker = buildReviewMarker('abc123')
    const { platform } = createPlatformWithPublishedItems({
      comments: [
        {
          body: marker,
          user: {
            login: 'review-bot',
          },
        },
      ],
      reviews: [],
    })

    const result = await platform.hasPublishedResult(
      createPullRequestContext(),
      marker,
    )

    expect(result).toBe(true)
  })

  it('builds discussion markdown from GraphQL review threads when available', async () => {
    const graphql = vi.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          comments: {
            nodes: [
              {
                author: { login: 'maintainer' },
                body: 'Please clarify this section.',
                createdAt: '2026-04-15T00:00:00Z',
              },
            ],
          },
          reviews: {
            nodes: [
              {
                author: { login: 'review-bot' },
                body: 'Looks good overall.',
                state: 'APPROVED',
                submittedAt: '2026-04-15T00:01:00Z',
              },
            ],
          },
          reviewThreads: {
            nodes: [
              {
                isResolved: true,
                resolvedBy: { login: 'maintainer' },
                comments: {
                  nodes: [
                    {
                      author: { login: 'review-bot' },
                      body: 'Potential null access.',
                      createdAt: '2026-04-15T00:02:00Z',
                      line: 12,
                      path: 'src/app.ts',
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    })

    const platform = createGitHubReviewPlatform(
      {
        githubToken: 'ghp_test_token',
        githubBotLogin: 'review-bot',
      },
      {
        createOctokit: () =>
          ({
            graphql,
            paginate: vi.fn().mockResolvedValue([]),
            rest: {
              pulls: {
                listFiles: vi.fn(),
                listReviewComments: vi.fn(),
                listReviews: vi.fn(),
                createReview: vi.fn(),
              },
              issues: {
                listComments: vi.fn(),
                createComment: vi.fn(),
              },
              repos: {
                getContent: vi.fn(),
              },
            },
          }) as never,
      },
    )

    const markdown = await platform.getPullRequestDiscussionMarkdown(
      createPullRequestContext(),
    )

    expect(markdown).toContain('Source: graphql')
    expect(markdown).toContain('resolved by @maintainer')
    expect(markdown).toContain('src/app.ts:12')
    expect(markdown).toContain('Potential null access.')
  })

  it('falls back to REST discussion sources when GraphQL fails', async () => {
    const listReviews = vi.fn()
    const listComments = vi.fn()
    const listReviewComments = vi.fn()
    const paginate = vi.fn((route: unknown) => {
      if (route === listReviews) {
        return Promise.resolve([
          {
            body: 'REST review body',
            state: 'APPROVED',
            submitted_at: '2026-04-15T00:01:00Z',
            user: { login: 'reviewer' },
          },
        ])
      }

      if (route === listComments) {
        return Promise.resolve([
          {
            body: 'REST issue comment',
            created_at: '2026-04-15T00:00:00Z',
            user: { login: 'maintainer' },
          },
        ])
      }

      if (route === listReviewComments) {
        return Promise.resolve([
          {
            body: 'REST review thread comment',
            created_at: '2026-04-15T00:02:00Z',
            line: 44,
            path: 'src/server.ts',
            user: { login: 'reviewer' },
          },
        ])
      }

      return Promise.resolve([])
    })

    const platform = createGitHubReviewPlatform(
      {
        githubToken: 'ghp_test_token',
        githubBotLogin: 'review-bot',
      },
      {
        createOctokit: () =>
          ({
            graphql: vi
              .fn()
              .mockRejectedValue(new Error('GraphQL unavailable')),
            paginate,
            rest: {
              pulls: {
                listFiles: vi.fn(),
                listReviewComments,
                listReviews,
                createReview: vi.fn(),
              },
              issues: {
                listComments,
                createComment: vi.fn(),
              },
              repos: {
                getContent: vi.fn(),
              },
            },
          }) as never,
      },
    )

    const markdown = await platform.getPullRequestDiscussionMarkdown(
      createPullRequestContext(),
    )

    expect(markdown).toContain('Source: rest')
    expect(markdown).toContain('REST issue comment')
    expect(markdown).toContain('src/server.ts:44')
  })

  it('fetches PR info and truncates long commit messages', async () => {
    const longMessage = 'x'.repeat(250)
    const get = vi.fn().mockResolvedValue({
      data: {
        title: 'My PR',
        body: 'Some description',
        html_url: 'https://github.com/acme/repo/pull/42',
      },
    })
    const listCommits = vi.fn().mockResolvedValue({
      data: [
        { sha: 'sha1', commit: { message: 'Short message' } },
        { sha: 'sha2', commit: { message: longMessage } },
      ],
    })
    const listFiles = vi.fn()
    const paginate = vi.fn((route: unknown) => {
      if (route === listFiles) {
        return Promise.resolve([
          { filename: 'src/app.ts' },
          { filename: 'src/utils.ts' },
        ])
      }
      return Promise.resolve([])
    })

    const platform = createGitHubReviewPlatform(
      {
        githubToken: 'ghp_test_token',
        githubBotLogin: 'review-bot',
      },
      {
        createOctokit: () =>
          ({
            paginate,
            rest: {
              pulls: {
                get,
                listFiles,
                listCommits,
                listReviews: vi.fn(),
                createReview: vi.fn(),
              },
              issues: {
                listComments: vi.fn(),
                createComment: vi.fn(),
              },
              repos: {
                getContent: vi.fn(),
              },
            },
          }) as never,
      },
    )

    const result = await platform.getPRInfo(createPullRequestContext())

    expect(result.title).toBe('My PR')
    expect(result.description).toBe('Some description')
    expect(result.commits).toHaveLength(2)
    expect(result.commits[0]).toEqual({ sha: 'sha1', message: 'Short message' })
    // Long message should be truncated to 200 chars + "..."
    expect(result.commits[1]?.message).toHaveLength(203)
    expect(result.commits[1]?.message).toContain('...')
    expect(result.changedFilePaths).toEqual(['src/app.ts', 'src/utils.ts'])
    expect(result.owner).toBe('acme')
    expect(result.repo).toBe('repo')
    expect(result.pullNumber).toBe(42)
  })

  it('returns no prior successful review when bot has no qualifying review states', async () => {
    const listReviews = vi.fn()
    const paginate = vi.fn((route: unknown) => {
      if (route === listReviews) {
        return Promise.resolve([
          {
            commit_id: 'sha-human',
            state: 'APPROVED',
            submitted_at: '2026-04-15T00:01:00Z',
            user: { login: 'teammate' },
          },
          {
            commit_id: 'sha-bot-pending',
            state: 'PENDING',
            submitted_at: '2026-04-15T00:02:00Z',
            user: { login: 'review-bot' },
          },
        ])
      }

      return Promise.resolve([])
    })

    const platform = createGitHubReviewPlatform(
      {
        githubToken: 'ghp_test_token',
        githubBotLogin: 'review-bot',
      },
      {
        createOctokit: () =>
          ({
            paginate,
            rest: {
              pulls: {
                listFiles: vi.fn(),
                listReviews,
                listReviewComments: vi.fn(),
                listCommits: vi.fn(),
                createReview: vi.fn(),
                get: vi.fn(),
              },
              issues: {
                listComments: vi.fn(),
                createComment: vi.fn(),
              },
              repos: {
                getContent: vi.fn(),
              },
            },
          }) as never,
      },
    )

    const result = await platform.getPriorSuccessfulReview(
      createPullRequestContext(),
    )

    expect(result).toEqual({
      hasPriorSuccessfulReview: false,
      latestReviewedSha: null,
      latestReviewState: null,
    })
  })

  it('returns latest successful bot review metadata for re-review mode selection', async () => {
    const listReviews = vi.fn()
    const paginate = vi.fn((route: unknown) => {
      if (route === listReviews) {
        return Promise.resolve([
          {
            commit_id: 'sha-old',
            state: 'CHANGES_REQUESTED',
            submitted_at: '2026-04-15T00:01:00Z',
            user: { login: 'review-bot' },
          },
          {
            commit_id: 'sha-new',
            state: 'COMMENTED',
            submitted_at: '2026-04-16T00:01:00Z',
            user: { login: 'review-bot' },
          },
        ])
      }

      return Promise.resolve([])
    })

    const platform = createGitHubReviewPlatform(
      {
        githubToken: 'ghp_test_token',
        githubBotLogin: 'review-bot',
      },
      {
        createOctokit: () =>
          ({
            paginate,
            rest: {
              pulls: {
                listFiles: vi.fn(),
                listReviews,
                listReviewComments: vi.fn(),
                listCommits: vi.fn(),
                createReview: vi.fn(),
                get: vi.fn(),
              },
              issues: {
                listComments: vi.fn(),
                createComment: vi.fn(),
              },
              repos: {
                getContent: vi.fn(),
              },
            },
          }) as never,
      },
    )

    const result = await platform.getPriorSuccessfulReview(
      createPullRequestContext(),
    )

    expect(result).toEqual({
      hasPriorSuccessfulReview: true,
      latestReviewedSha: 'sha-new',
      latestReviewState: 'COMMENTED',
    })
  })
})
