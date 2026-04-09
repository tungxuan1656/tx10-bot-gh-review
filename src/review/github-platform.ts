import { Octokit } from "@octokit/rest";

import type { AppConfig } from "../config.js";
import type {
  GitHubPullRequestFile,
  InlineReviewComment,
  PullRequestContext,
  ReviewEvent,
} from "./types.js";

type ReviewPlatform = {
  listPullRequestFiles(context: PullRequestContext): Promise<GitHubPullRequestFile[]>;
  getFileContent(context: PullRequestContext, path: string): Promise<string | null>;
  hasPublishedResult(context: PullRequestContext, marker: string): Promise<boolean>;
  publishReview(input: {
    context: PullRequestContext;
    body: string;
    event: ReviewEvent;
    comments: InlineReviewComment[];
  }): Promise<void>;
  publishFailureComment(context: PullRequestContext, body: string): Promise<void>;
};

type InstallationOctokit = Pick<Octokit, "paginate"> & {
  rest: Pick<Octokit["rest"], "issues" | "pulls" | "repos">;
};

type GitHubReviewPlatformDependencies = {
  createOctokit?: () => InstallationOctokit;
};

type ReviewResultMarkerAuthor = {
  body?: string | null;
  user?: {
    login?: string | null;
  } | null;
};

function decodeBase64Content(content: string): string {
  return Buffer.from(content, "base64").toString("utf8");
}

export function hasMarkerFromAppBot(
  item: ReviewResultMarkerAuthor,
  marker: string,
  appBotLogin: string,
): boolean {
  return item.body?.includes(marker) === true && item.user?.login === appBotLogin;
}

export function createGitHubReviewPlatform(config: Pick<
  AppConfig,
  "githubToken" | "githubBotLogin"
>, dependencies: GitHubReviewPlatformDependencies = {}): ReviewPlatform {
  const getOctokit =
    dependencies.createOctokit ??
    (() =>
      new Octokit({
        auth: config.githubToken,
      }));

  return {
    async listPullRequestFiles(context) {
      const octokit = getOctokit();
      const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner: context.owner,
        repo: context.repo,
        pull_number: context.pullNumber,
        per_page: 100,
      });

      return files.map((file) => ({
        path: file.filename,
        status: file.status,
        ...(file.patch ? { patch: file.patch } : {}),
      }));
    },

    async getFileContent(context, path) {
      const octokit = getOctokit();
      const response = await octokit.rest.repos.getContent({
        owner: context.owner,
        repo: context.repo,
        path,
        ref: context.headSha,
      });

      if (Array.isArray(response.data) || response.data.type !== "file" || !response.data.content) {
        return null;
      }

      return decodeBase64Content(response.data.content);
    },

    async hasPublishedResult(context, marker) {
      const octokit = getOctokit();

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
      ]);

      return [...reviews, ...comments].some((item) =>
        hasMarkerFromAppBot(item, marker, config.githubBotLogin),
      );
    },

    async publishReview({ context, body, event, comments }) {
      const octokit = getOctokit();

      await octokit.rest.pulls.createReview({
        owner: context.owner,
        repo: context.repo,
        pull_number: context.pullNumber,
        commit_id: context.headSha,
        event,
        body,
        comments,
      });
    },

    async publishFailureComment(context, body) {
      const octokit = getOctokit();

      await octokit.rest.issues.createComment({
        owner: context.owner,
        repo: context.repo,
        issue_number: context.pullNumber,
        body,
      });
    },
  };
}

export type { ReviewPlatform };
