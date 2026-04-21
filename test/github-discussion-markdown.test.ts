import { describe, expect, it } from 'vitest'

import { renderPullRequestDiscussionMarkdown } from '../src/review/github-discussion-markdown.js'
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

describe('github discussion markdown', () => {
  it('renders empty discussion sections with source metadata', () => {
    const markdown = renderPullRequestDiscussionMarkdown({
      context: createPullRequestContext(),
      generatedAt: '2026-04-21T00:00:00.000Z',
      payload: {
        issueComments: [],
        reviews: [],
        reviewThreads: [],
        source: 'graphql',
      },
    })

    expect(markdown).toContain('Generated At: 2026-04-21T00:00:00.000Z')
    expect(markdown).toContain('## Issue Comments')
    expect(markdown).toContain('- None')
    expect(markdown).toContain('Source: graphql')
  })

  it('sanitizes empty and long discussion bodies', () => {
    const markdown = renderPullRequestDiscussionMarkdown({
      context: createPullRequestContext(),
      generatedAt: '2026-04-21T00:00:00.000Z',
      payload: {
        issueComments: [
          {
            authorLogin: 'review-bot',
            body: '',
            createdAt: '2026-04-20T00:00:00Z',
          },
          {
            authorLogin: 'review-bot',
            body: 'x'.repeat(2001),
            createdAt: '2026-04-20T00:01:00Z',
          },
        ],
        reviews: [],
        reviewThreads: [],
        source: 'rest',
      },
    })

    expect(markdown).toContain('(empty comment)')
    expect(markdown).toContain('...[truncated]')
  })

  it('renders thread locations and resolution metadata', () => {
    const markdown = renderPullRequestDiscussionMarkdown({
      context: createPullRequestContext(),
      generatedAt: '2026-04-21T00:00:00.000Z',
      payload: {
        issueComments: [],
        reviews: [],
        reviewThreads: [
          {
            comments: [
              {
                authorLogin: 'maintainer',
                body: 'Please update this.',
                createdAt: '2026-04-20T00:00:00Z',
                line: 12,
                path: 'src/app.ts',
              },
            ],
            isResolved: true,
            resolvedByLogin: 'maintainer',
          },
        ],
        source: 'graphql',
      },
    })

    expect(markdown).toContain('resolved by @maintainer')
    expect(markdown).toContain('src/app.ts:12')
    expect(markdown).toContain('Please update this.')
  })
})
