import type { InstallationOctokit } from './discussion.js'
import type {
  GitHubPullRequestFile,
  InlineReviewComment,
  PRInfoObject,
  PriorSuccessfulReviewInfo,
  PullRequestContext,
  ReviewEvent,
} from './core.js'

export type ReviewReaction = 'eyes' | 'hooray' | 'confused' | 'laugh'

export type IssueReaction = {
  content?: string | null
  id: number
  user?: {
    login?: string | null
  } | null
}

export type ReviewPlatform = {
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
  getPullRequestDiscussionMarkdown(
    context: PullRequestContext,
  ): Promise<string>
  getPriorSuccessfulReview(
    context: PullRequestContext,
  ): Promise<PriorSuccessfulReviewInfo>
  getPRInfo(context: PullRequestContext): Promise<PRInfoObject>
  setPullRequestReaction(
    context: PullRequestContext,
    reaction: ReviewReaction,
  ): Promise<void>
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

export type GitHubReviewPlatformDependencies = {
  createOctokit?: () => InstallationOctokit
}
