import { createAppAuth } from "@octokit/auth-app";
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

type AppOctokit = Pick<Octokit, "request">;

type GitHubReviewPlatformDependencies = {
  createAppOctokit?: () => AppOctokit;
  createInstallationOctokit?: (installationId: number) => InstallationOctokit;
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
  "githubAppId" | "githubPrivateKey" | "githubInstallationId"
>, dependencies: GitHubReviewPlatformDependencies = {}): ReviewPlatform {
  const getInstallationOctokit =
    dependencies.createInstallationOctokit ??
    ((installationId: number): InstallationOctokit => {
      const resolvedInstallationId = config.githubInstallationId ?? installationId;

      return new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: config.githubAppId,
          privateKey: config.githubPrivateKey,
          installationId: resolvedInstallationId,
        },
      });
    });

  const getAppOctokit =
    dependencies.createAppOctokit ??
    (() =>
      new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: config.githubAppId,
          privateKey: config.githubPrivateKey,
        },
      }));

  let appBotLoginPromise: Promise<string> | undefined;

  const getAppBotLogin = () => {
    if (!appBotLoginPromise) {
      appBotLoginPromise = getAppOctokit()
        .request("GET /app")
        .then(({ data }) => {
          if (!data?.slug) {
            throw new Error("GitHub App metadata did not include a slug.");
          }

          return `${data.slug}[bot]`;
        });
    }

    return appBotLoginPromise;
  };

  const getOctokitForInstallation = (installationId: number) => {
    const resolvedInstallationId = config.githubInstallationId ?? installationId;

    return getInstallationOctokit(resolvedInstallationId);
  };

  return {
    async listPullRequestFiles(context) {
      const octokit = getOctokitForInstallation(context.installationId);
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
      const octokit = getOctokitForInstallation(context.installationId);
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
      const octokit = getOctokitForInstallation(context.installationId);
      const appBotLogin = await getAppBotLogin();

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

      return [...reviews, ...comments].some((item) => hasMarkerFromAppBot(item, marker, appBotLogin));
    },

    async publishReview({ context, body, event, comments }) {
      const octokit = getOctokitForInstallation(context.installationId);

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
      const octokit = getOctokitForInstallation(context.installationId);

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
