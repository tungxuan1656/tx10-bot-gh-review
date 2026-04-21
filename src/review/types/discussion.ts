import type { Octokit } from '@octokit/rest'

export type DiscussionCacheOptions = {
  discussionCacheDirectory?: string
  discussionCacheTtlMs?: number
}

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
