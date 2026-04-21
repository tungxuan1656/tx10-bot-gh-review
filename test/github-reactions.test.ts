import { describe, expect, it, vi } from 'vitest'

import type { PullRequestContext } from '../src/review/types.js'
import { setPullRequestReaction } from '../src/review/github-reactions.js'

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

function createOctokit(input: {
  reactions: Array<{
    content?: string | null
    id: number
    user?: { login?: string | null }
  }>
}) {
  const listForIssue = vi.fn()
  const createForIssue = vi.fn()
  const deleteForIssue = vi.fn()
  const paginate = vi.fn((route: unknown) => {
    if (route === listForIssue) {
      return Promise.resolve(input.reactions)
    }

    return Promise.resolve([])
  })

  return {
    listForIssue,
    createForIssue,
    deleteForIssue,
    octokit: {
      paginate,
      rest: {
        reactions: {
          createForIssue,
          deleteForIssue,
          listForIssue,
        },
      },
    } as never,
  }
}

describe('github reactions', () => {
  it('leaves a matching bot reaction untouched when it is the only one', async () => {
    const { octokit, createForIssue, deleteForIssue } = createOctokit({
      reactions: [
        {
          content: 'hooray',
          id: 1,
          user: { login: 'review-bot' },
        },
      ],
    })

    await setPullRequestReaction(
      octokit,
      createPullRequestContext(),
      'hooray',
      'review-bot',
    )

    expect(createForIssue).not.toHaveBeenCalled()
    expect(deleteForIssue).not.toHaveBeenCalled()
  })

  it('replaces stale bot reactions when the requested reaction changes', async () => {
    const { octokit, createForIssue, deleteForIssue } = createOctokit({
      reactions: [
        {
          content: 'laugh',
          id: 11,
          user: { login: 'review-bot' },
        },
        {
          content: 'eyes',
          id: 12,
          user: { login: 'teammate' },
        },
      ],
    })

    await setPullRequestReaction(
      octokit,
      createPullRequestContext(),
      'confused',
      'review-bot',
    )

    expect(createForIssue).toHaveBeenCalledWith({
      content: 'confused',
      issue_number: 42,
      owner: 'acme',
      repo: 'repo',
    })
    expect(deleteForIssue).toHaveBeenCalledWith({
      issue_number: 42,
      owner: 'acme',
      reaction_id: 11,
      repo: 'repo',
    })
  })

  it('creates a bot reaction when none exists yet', async () => {
    const { octokit, createForIssue, deleteForIssue } = createOctokit({
      reactions: [],
    })

    await setPullRequestReaction(
      octokit,
      createPullRequestContext(),
      'laugh',
      'review-bot',
    )

    expect(createForIssue).toHaveBeenCalledWith({
      content: 'laugh',
      issue_number: 42,
      owner: 'acme',
      repo: 'repo',
    })
    expect(deleteForIssue).not.toHaveBeenCalled()
  })
})
