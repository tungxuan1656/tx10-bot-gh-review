import type { PullRequestContext } from './types.js'
import type { PullRequestDiscussionPayload } from './github-discussion.js'

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

export function renderPullRequestDiscussionMarkdown(input: {
  context: PullRequestContext
  generatedAt: string
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
    `Generated At: ${input.generatedAt}`,
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
