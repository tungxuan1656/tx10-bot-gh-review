import { renderPullRequestDiscussionMarkdown } from './github-discussion-markdown.js'
import type {
  DiscussionAuthor,
  InstallationOctokit,
  PullRequestContext,
  PullRequestDiscussionPayload,
} from './types.js'

export type {
  DiscussionAuthor,
  InstallationOctokit,
  PullRequestDiscussionPayload,
} from './types.js'

function toAuthorLogin(author: DiscussionAuthor): string {
  return author?.login ?? 'unknown'
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

  return renderPullRequestDiscussionMarkdown({
    context,
    generatedAt: new Date().toISOString(),
    payload,
  })
}
