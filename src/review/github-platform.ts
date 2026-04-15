import { Octokit } from '@octokit/rest'

import type { AppConfig } from '../config.js'
import type {
  GitHubPullRequestFile,
  InlineReviewComment,
  PRCommit,
  PRInfoObject,
  PullRequestContext,
  ReviewEvent,
} from './types.js'

const maxCommits = 30
const maxCommitMessageChars = 200

type ReviewPlatform = {
  listPullRequestFiles(
    context: PullRequestContext,
  ): Promise<GitHubPullRequestFile[]>
  getFileContent(
    context: PullRequestContext,
    path: string,
  ): Promise<string | null>
  hasPublishedResult(
    context: PullRequestContext,
    marker: string,
  ): Promise<boolean>
  getPullRequestDiscussionMarkdown(context: PullRequestContext): Promise<string>
  getPRInfo(context: PullRequestContext): Promise<PRInfoObject>
  publishReview(input: {
    context: PullRequestContext
    body: string
    event: ReviewEvent
    comments: InlineReviewComment[]
  }): Promise<void>
  publishFailureComment(
    context: PullRequestContext,
    body: string,
  ): Promise<void>
}

type InstallationOctokit = Pick<Octokit, 'paginate'> & {
  graphql?: Octokit['graphql']
  rest: Pick<Octokit['rest'], 'issues' | 'pulls' | 'repos'>
}

type GitHubReviewPlatformDependencies = {
  createOctokit?: () => InstallationOctokit
}

type ReviewResultMarkerAuthor = {
  body?: string | null
  user?: {
    login?: string | null
  } | null
}

type DiscussionAuthor = {
  login?: string | null
} | null

type PullRequestDiscussionPayload = {
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

function truncateCommitMessage(message: string): string {
  const firstLine = message.split('\n')[0] ?? message
  if (firstLine.length <= maxCommitMessageChars) {
    return firstLine
  }
  return `${firstLine.slice(0, maxCommitMessageChars)}...`
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

function decodeBase64Content(content: string): string {
  return Buffer.from(content, 'base64').toString('utf8')
}

export function hasMarkerFromAppBot(
  item: ReviewResultMarkerAuthor,
  marker: string,
  appBotLogin: string,
): boolean {
  return (
    item.body?.includes(marker) === true && item.user?.login === appBotLogin
  )
}

export function createGitHubReviewPlatform(
  config: Pick<AppConfig, 'githubToken' | 'githubBotLogin'>,
  dependencies: GitHubReviewPlatformDependencies = {},
): ReviewPlatform {
  const getOctokit =
    dependencies.createOctokit ??
    (() =>
      new Octokit({
        auth: config.githubToken,
      }))

  return {
    async listPullRequestFiles(context) {
      const octokit = getOctokit()
      const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner: context.owner,
        repo: context.repo,
        pull_number: context.pullNumber,
        per_page: 100,
      })

      return files.map((file) => ({
        path: file.filename,
        status: file.status,
        ...(file.patch ? { patch: file.patch } : {}),
      }))
    },

    async getFileContent(context, path) {
      const octokit = getOctokit()
      const response = await octokit.rest.repos.getContent({
        owner: context.owner,
        repo: context.repo,
        path,
        ref: context.headSha,
      })

      if (
        Array.isArray(response.data) ||
        response.data.type !== 'file' ||
        !response.data.content
      ) {
        return null
      }

      return decodeBase64Content(response.data.content)
    },

    async hasPublishedResult(context, marker) {
      const octokit = getOctokit()

      const [reviews, comments] = await Promise.all([
        octokit.paginate(octokit.rest.pulls.listReviews, {
          owner: context.owner,
          repo: context.repo,
          pull_number: context.pullNumber,
          per_page: 100,
        }),
        octokit.paginate(octokit.rest.issues.listComments, {
          owner: context.owner,
          repo: context.repo,
          issue_number: context.pullNumber,
          per_page: 100,
        }),
      ])

      return [...reviews, ...comments].some((item) =>
        hasMarkerFromAppBot(item, marker, config.githubBotLogin),
      )
    },

    async getPullRequestDiscussionMarkdown(context) {
      const octokit = getOctokit()
      const graphQlPayload = await fetchDiscussionWithGraphQl(octokit, context)
      const payload =
        graphQlPayload ?? (await fetchDiscussionWithRest(octokit, context))

      return toDiscussionMarkdown({
        context,
        payload,
      })
    },

    async getPRInfo(context) {
      const octokit = getOctokit()

      const [commitsRaw, filesRaw, prRaw] = await Promise.all([
        octokit.rest.pulls.listCommits({
          owner: context.owner,
          repo: context.repo,
          pull_number: context.pullNumber,
          per_page: maxCommits,
        }),
        octokit.paginate(octokit.rest.pulls.listFiles, {
          owner: context.owner,
          repo: context.repo,
          pull_number: context.pullNumber,
          per_page: 100,
        }),
        octokit.rest.pulls.get({
          owner: context.owner,
          repo: context.repo,
          pull_number: context.pullNumber,
        }),
      ])

      const commits: PRCommit[] = commitsRaw.data.map((c) => ({
        sha: c.sha,
        message: truncateCommitMessage(c.commit.message),
      }))

      const changedFilePaths = filesRaw.map((f) => f.filename)

      return {
        owner: context.owner,
        repo: context.repo,
        pullNumber: context.pullNumber,
        title: prRaw.data.title,
        description: (prRaw.data.body ?? '').slice(0, 4_000),
        headSha: context.headSha,
        baseSha: context.baseSha,
        headRef: context.headRef,
        baseRef: context.baseRef,
        htmlUrl: prRaw.data.html_url,
        commits,
        changedFilePaths,
      }
    },

    async publishReview({ context, body, event, comments }) {
      const octokit = getOctokit()

      await octokit.rest.pulls.createReview({
        owner: context.owner,
        repo: context.repo,
        pull_number: context.pullNumber,
        commit_id: context.headSha,
        event,
        body,
        comments,
      })
    },

    async publishFailureComment(context, body) {
      const octokit = getOctokit()

      await octokit.rest.issues.createComment({
        owner: context.owner,
        repo: context.repo,
        issue_number: context.pullNumber,
        body,
      })
    },
  }
}

export type { ReviewPlatform }
