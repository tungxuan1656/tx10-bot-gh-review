import { Octokit } from '@octokit/rest'

import type { AppConfig } from '../config.js'
import type {
  GitHubPullRequestFile,
  InlineReviewComment,
  PriorSuccessfulReviewInfo,
  PRInfoObject,
  PullRequestContext,
  ReviewEvent,
} from './types.js'
import {
  getPullRequestDiscussionMarkdown,
  type InstallationOctokit,
} from './github-discussion.js'
import {
  setPullRequestReaction as setPullRequestIssueReaction,
  type ReviewReaction,
} from './github-reactions.js'
import {
  getFileContent as getPullRequestFileContent,
  getPRInfo as getPullRequestInfo,
  getPriorSuccessfulReview as getPullRequestPriorSuccessfulReview,
  hasPublishedResult as hasPullRequestPublishedResult,
  listPullRequestFiles,
} from './github-pr-data.js'

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

type GitHubReviewPlatformDependencies = {
  createOctokit?: () => InstallationOctokit
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
      return listPullRequestFiles(octokit, context)
    },

    async getFileContent(context, path) {
      const octokit = getOctokit()
      return getPullRequestFileContent(octokit, context, path)
    },

    async hasPublishedResult(context, marker) {
      const octokit = getOctokit()
      return hasPullRequestPublishedResult(
        octokit,
        context,
        marker,
        config.githubBotLogin,
      )
    },

    async getPullRequestDiscussionMarkdown(context) {
      const octokit = getOctokit()
      return getPullRequestDiscussionMarkdown(octokit, context)
    },

    async getPriorSuccessfulReview(context) {
      const octokit = getOctokit()
      return getPullRequestPriorSuccessfulReview(
        octokit,
        context,
        config.githubBotLogin,
      )
    },

    async getPRInfo(context) {
      const octokit = getOctokit()
      return getPullRequestInfo(octokit, context)
    },

    async setPullRequestReaction(context, reaction) {
      const octokit = getOctokit()
      await setPullRequestIssueReaction(
        octokit,
        context,
        reaction,
        config.githubBotLogin,
      )
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
