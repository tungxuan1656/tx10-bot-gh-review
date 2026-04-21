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
  getFileContent as getPullRequestFileContent,
  getPRInfo as getPullRequestInfo,
  getPriorSuccessfulReview as getPullRequestPriorSuccessfulReview,
  hasPublishedResult as hasPullRequestPublishedResult,
  listPullRequestFiles,
} from './github-pr-data.js'

export type ReviewReaction = 'eyes' | 'hooray' | 'confused' | 'laugh'

const reviewReactionContents = new Set<ReviewReaction>([
  'eyes',
  'hooray',
  'confused',
  'laugh',
])

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

type IssueReaction = {
  content?: string | null
  id: number
  user?: {
    login?: string | null
  } | null
}

function isReviewReactionContent(
  content: string | null | undefined,
): content is ReviewReaction {
  return (
    typeof content === 'string' &&
    reviewReactionContents.has(content as ReviewReaction)
  )
}

function isBotAuthoredReaction(
  reaction: IssueReaction,
  botLogin: string,
): boolean {
  return (
    reaction.user?.login === botLogin &&
    isReviewReactionContent(reaction.content)
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

      const currentReactions = await octokit.paginate(
        octokit.rest.reactions.listForIssue,
        {
          owner: context.owner,
          repo: context.repo,
          issue_number: context.pullNumber,
          per_page: 100,
        },
      )

      const botReactions = (currentReactions as IssueReaction[]).filter((item) =>
        isBotAuthoredReaction(item, config.githubBotLogin),
      )

      const matchingReaction = botReactions.find(
        (item) => item.content === reaction,
      )

      if (botReactions.length === 1 && matchingReaction) {
        return
      }

      const staleReactions = botReactions.filter(
        (item) => item.content !== reaction,
      )

      if (matchingReaction) {
        if (staleReactions.length > 0) {
          await Promise.all(
            staleReactions.map((item) =>
              octokit.rest.reactions.deleteForIssue({
                owner: context.owner,
                repo: context.repo,
                reaction_id: item.id,
                issue_number: context.pullNumber,
              }),
            ),
          )
        }

        return
      }

      await octokit.rest.reactions.createForIssue({
        owner: context.owner,
        repo: context.repo,
        issue_number: context.pullNumber,
        content: reaction,
      })

      if (staleReactions.length === 0) {
        return
      }

      await Promise.all(
        staleReactions.map((item) =>
          octokit.rest.reactions.deleteForIssue({
            owner: context.owner,
            repo: context.repo,
            reaction_id: item.id,
            issue_number: context.pullNumber,
          }),
        ),
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
