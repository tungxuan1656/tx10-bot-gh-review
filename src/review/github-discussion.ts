import type { Octokit } from '@octokit/rest'

import type { PullRequestContext } from './types.js'

export type DiscussionAuthor = {
  login?: string | null
} | null

export type PullRequestDiscussionPayload = {
  issueComments: Array<{
    authorLogin: string
    body: string
    createdAt: string
  }>
  reviews: Array<{
    authorLogin: string
    body: string
    state: string
    submittedAt: string
  }>
  reviewThreads: Array<{
    comments: Array<{
      authorLogin: string
      body: string
      createdAt: string
      line: number | null
      path: string | null
    }>
    isResolved: boolean
    resolvedByLogin: string | null
  }>
  source: 'graphql' | 'rest'
}

export type InstallationOctokit = Pick<Octokit, 'paginate' | 'graphql' | 'rest'>

function toAuthorLogin(author: DiscussionAuthor): string {
  return author?.login ?? 'unknown'
}

function sanitizeDiscussionBody(body: string | null | undefined): string {
  const normalized = (body ?? '').replace(/\r\n/g, '\n').trim()

  if (!normalized) {
    return '(empty comment)'
  }

  const maxBodyCharacters = 2_000
  if (normalized.length <= maxBodyCharacters) {
    return normalized
  }

  return `${normalized.slice(0, maxBodyCharacters)}\n...[truncated]`
}

function toDiscussionMarkdown(input: {
  context: PullRequestContext
  payload: PullRequestDiscussionPayload
}): string {
  const issueCommentLines =
    input.payload.issueComments.length === 0
      ? ['- None']
      : input.payload.issueComments.map((comment) =>
          [
            `- [${comment.createdAt}] @${comment.authorLogin}`,
            sanitizeDiscussionBody(comment.body),
          ].join('\n'),
        )

  const reviewLines =
    input.payload.reviews.length === 0
      ? ['- None']
      : input.payload.reviews.map((review) =>
          [
            `- [${review.submittedAt}] @${review.authorLogin} (${review.state})`,
            sanitizeDiscussionBody(review.body),
          ].join('\n'),
        )

  const reviewThreadLines =
    input.payload.reviewThreads.length === 0
      ? ['- None']
      : input.payload.reviewThreads.map((thread, threadIndex) => {
          const status = thread.isResolved
            ? `resolved by @${thread.resolvedByLogin ?? 'unknown'}`
            : 'unresolved'
          const comments =
            thread.comments.length === 0
              ? ['  - No comments in thread']
              : thread.comments.map((comment) => {
                  const location = comment.path
                    ? `${comment.path}${comment.line ? `:${comment.line}` : ''}`
                    : 'general'
                  return [
                    `  - [${comment.createdAt}] @${comment.authorLogin} (${location})`,
                    `    ${sanitizeDiscussionBody(comment.body).replace(/\n/g, '\n    ')}`,
                  ].join('\n')
                })

          return [`- Thread ${threadIndex + 1} (${status})`, ...comments].join(
            '\n',
          )
        })

  return [
    '# Pull Request Discussion Context',
    `Repository: ${input.context.owner}/${input.context.repo}`,
    `Pull Request: #${input.context.pullNumber}`,
    `Head SHA: ${input.context.headSha}`,
    `Source: ${input.payload.source}`,
    `Generated At: ${new Date().toISOString()}`,
    '',
    '## Issue Comments',
    ...issueCommentLines,
    '',
    '## Reviews',
    ...reviewLines,
    '',
    '## Review Threads',
    ...reviewThreadLines,
    '',
    'Use this context to avoid repeating already resolved findings and to incorporate maintainer explanations.',
  ].join('\n')
}

async function fetchDiscussionWithGraphQl(
  octokit: InstallationOctokit,
  context: PullRequestContext,
): Promise<PullRequestDiscussionPayload | null> {
  if (typeof octokit.graphql !== 'function') {
    return null
  }

  type GraphQlResponse = {
    repository: {
      pullRequest: {
        comments: {
          nodes: Array<{
            author: DiscussionAuthor
            body: string
            createdAt: string
          }>
        }
        reviews: {
          nodes: Array<{
            author: DiscussionAuthor
            body: string
            state: string
            submittedAt: string
          }>
        }
        reviewThreads: {
          nodes: Array<{
            isResolved: boolean
            resolvedBy: DiscussionAuthor
            comments: {
              nodes: Array<{
                author: DiscussionAuthor
                body: string
                createdAt: string
                line: number | null
                path: string | null
              }>
            }
          }>
        }
      } | null
    } | null
  }

  try {
    const response = await octokit.graphql<GraphQlResponse>(
      `query PullRequestDiscussion($owner: String!, $repo: String!, $pullNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pullNumber) {
            comments(first: 100) {
              nodes {
                author {
                  login
                }
                body
                createdAt
              }
            }
            reviews(first: 100) {
              nodes {
                author {
                  login
                }
                body
                state
                submittedAt
              }
            }
            reviewThreads(first: 100) {
              nodes {
                isResolved
                resolvedBy {
                  login
                }
                comments(first: 100) {
                  nodes {
                    author {
                      login
                    }
                    body
                    createdAt
                    line
                    path
                  }
                }
              }
            }
          }
        }
      }`,
      {
        owner: context.owner,
        repo: context.repo,
        pullNumber: context.pullNumber,
      },
    )

    const pullRequest = response.repository?.pullRequest
    if (!pullRequest) {
      return {
        issueComments: [],
        reviews: [],
        reviewThreads: [],
        source: 'graphql',
      }
    }

    return {
      issueComments: pullRequest.comments.nodes.map((comment) => ({
        authorLogin: toAuthorLogin(comment.author),
        body: comment.body,
        createdAt: comment.createdAt,
      })),
      reviews: pullRequest.reviews.nodes.map((review) => ({
        authorLogin: toAuthorLogin(review.author),
        body: review.body,
        state: review.state,
        submittedAt: review.submittedAt,
      })),
      reviewThreads: pullRequest.reviewThreads.nodes.map((thread) => ({
        comments: thread.comments.nodes.map((comment) => ({
          authorLogin: toAuthorLogin(comment.author),
          body: comment.body,
          createdAt: comment.createdAt,
          line: comment.line,
          path: comment.path,
        })),
        isResolved: thread.isResolved,
        resolvedByLogin: toAuthorLogin(thread.resolvedBy),
      })),
      source: 'graphql',
    }
  } catch {
    return null
  }
}

async function fetchDiscussionWithRest(
  octokit: InstallationOctokit,
  context: PullRequestContext,
): Promise<PullRequestDiscussionPayload> {
  const [issueComments, reviews, reviewComments] = await Promise.all([
    octokit.paginate(octokit.rest.issues.listComments, {
      owner: context.owner,
      repo: context.repo,
      issue_number: context.pullNumber,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.pulls.listReviews, {
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullNumber,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullNumber,
      per_page: 100,
    }),
  ])

  return {
    issueComments: issueComments.map((comment) => ({
      authorLogin: comment.user?.login ?? 'unknown',
      body: comment.body ?? '',
      createdAt: comment.created_at ?? 'unknown',
    })),
    reviews: reviews.map((review) => ({
      authorLogin: review.user?.login ?? 'unknown',
      body: review.body ?? '',
      state: review.state ?? 'UNKNOWN',
      submittedAt: review.submitted_at ?? 'unknown',
    })),
    reviewThreads: [
      {
        comments: reviewComments.map((comment) => ({
          authorLogin: comment.user?.login ?? 'unknown',
          body: comment.body ?? '',
          createdAt: comment.created_at ?? 'unknown',
          line: comment.line ?? null,
          path: comment.path ?? null,
        })),
        isResolved: false,
        resolvedByLogin: null,
      },
    ],
    source: 'rest',
  }
}

export async function getPullRequestDiscussionMarkdown(
  octokit: InstallationOctokit,
  context: PullRequestContext,
): Promise<string> {
  const graphQlPayload = await fetchDiscussionWithGraphQl(octokit, context)
  const payload = graphQlPayload ?? (await fetchDiscussionWithRest(octokit, context))

  return toDiscussionMarkdown({
    context,
    payload,
  })
}
