import { Octokit } from '@octokit/rest'

import type { AppConfig } from '../types/app.js'
import type { GitHubReviewPlatformDependencies, ReviewPlatform } from './types.js'
import {
  getPullRequestDiscussionMarkdown,
} from './github-discussion.js'
import {
  setPullRequestReaction as setPullRequestIssueReaction,
} from './github-reactions.js'
import {
  getFileContent as getPullRequestFileContent,
  getPRInfo as getPullRequestInfo,
  getPriorSuccessfulReview as getPullRequestPriorSuccessfulReview,
  hasPublishedResult as hasPullRequestPublishedResult,
  listPullRequestFiles,
} from './github-pr-data.js'

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
