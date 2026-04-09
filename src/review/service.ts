import { z } from "zod";

import { determineReviewEvent } from "./decision.js";
import { filterReviewableFiles } from "./filter-files.js";
import { isCommentableRightSideLine } from "./patch.js";
import { buildReviewPrompt } from "./prompt.js";
import { buildFailureComment, buildReviewBody, buildReviewMarker } from "./summary.js";
import type { AppLogger } from "../logger.js";
import type { CodexRunner } from "./codex.js";
import type { ReviewPlatform } from "./github-platform.js";
import type {
  GitHubPullRequestFile,
  InlineReviewComment,
  PullRequestContext,
  PullRequestWebhookPayload,
  ReviewFinding,
  ReviewableFile,
} from "./types.js";
import { isSupportedPullRequestAction } from "./types.js";

const webhookPayloadSchema = z.object({
  action: z.string(),
  installation: z.object({
    id: z.number().int().positive(),
  }),
  repository: z.object({
    name: z.string().min(1),
    owner: z.object({
      login: z.string().min(1),
    }),
  }),
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string().min(1),
    html_url: z.string().url(),
    head: z.object({
      sha: z.string().min(1),
    }),
    base: z.object({
      sha: z.string().min(1),
    }),
  }),
});

function toPullRequestContext(payload: PullRequestWebhookPayload): PullRequestContext {
  return {
    action: payload.action,
    installationId: payload.installation.id,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    pullNumber: payload.pull_request.number,
    title: payload.pull_request.title,
    htmlUrl: payload.pull_request.html_url,
    headSha: payload.pull_request.head.sha,
    baseSha: payload.pull_request.base.sha,
  };
}

function buildRunKey(context: PullRequestContext): string {
  return `${context.owner}/${context.repo}#${context.pullNumber}@${context.headSha}`;
}

function toInlineComment(finding: ReviewFinding): string {
  return [
    `**${finding.severity.toUpperCase()}**: ${finding.title}`,
    "",
    finding.comment,
  ].join("\n");
}

function separateInlineAndOverflowFindings(
  findings: ReviewFinding[],
  files: ReviewableFile[],
): {
  comments: InlineReviewComment[];
  overflowFindings: ReviewFinding[];
} {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const comments: InlineReviewComment[] = [];
  const overflowFindings: ReviewFinding[] = [];

  for (const finding of findings) {
    const file = filesByPath.get(finding.path);

    if (!file || !isCommentableRightSideLine(file.patch, finding.line)) {
      overflowFindings.push(finding);
      continue;
    }

    comments.push({
      path: finding.path,
      line: finding.line,
      side: "RIGHT",
      body: toInlineComment(finding),
    });
  }

  return { comments, overflowFindings };
}

function isInvalidInlineReviewCommentError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    errors?: Array<{
      code?: string;
      field?: string;
      message?: string;
      resource?: string;
    }>;
    message?: string;
    status?: number;
  };

  if (candidate.status !== 422) {
    return false;
  }

  const lowerCaseMessage = candidate.message?.toLowerCase() ?? "";
  if (
    lowerCaseMessage.includes("review comments is invalid") ||
    lowerCaseMessage.includes("review threads is invalid")
  ) {
    return true;
  }

  return (candidate.errors ?? []).some((validationError) => {
    const resource = validationError.resource?.toLowerCase();
    const field = validationError.field?.toLowerCase();
    const message = validationError.message?.toLowerCase() ?? "";

    return (
      resource === "pullrequestreviewcomment" ||
      resource === "pullrequestreviewthread" ||
      field === "line" ||
      field === "side" ||
      field === "start_line" ||
      field === "start_side" ||
      field === "path" ||
      message.includes("review comment") ||
      message.includes("review thread")
    );
  });
}

export class ReviewService {
  private readonly activeRuns = new Set<string>();

  constructor(
    private readonly github: ReviewPlatform,
    private readonly codex: CodexRunner,
    private readonly logger: AppLogger,
  ) {}

  async handlePullRequestWebhook(payload: unknown): Promise<void> {
    const parsed = webhookPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      this.logger.warn({ issues: parsed.error.issues }, "Ignored invalid pull_request payload");
      return;
    }

    if (!isSupportedPullRequestAction(parsed.data.action)) {
      this.logger.debug({ action: parsed.data.action }, "Ignored unsupported pull_request action");
      return;
    }

    await this.reviewPullRequest({
      ...parsed.data,
      action: parsed.data.action,
    });
  }

  private async reviewPullRequest(payload: PullRequestWebhookPayload): Promise<void> {
    const context = toPullRequestContext(payload);
    const runKey = buildRunKey(context);
    const marker = buildReviewMarker(context.headSha);

    if (this.activeRuns.has(runKey)) {
      this.logger.info({ runKey }, "Skipped duplicate in-flight review run");
      return;
    }

    this.activeRuns.add(runKey);

    try {
      if (await this.github.hasPublishedResult(context, marker)) {
        this.logger.info({ runKey }, "Skipped already published review result");
        return;
      }

      const changedFiles = await this.github.listPullRequestFiles(context);
      const reviewableFiles = await this.hydrateReviewableFiles(context, changedFiles);

      if (reviewableFiles.length === 0) {
        this.logger.info(
          { runKey, changedFileCount: changedFiles.length },
          "No reviewable files found for pull request",
        );
        return;
      }

      const prompt = buildReviewPrompt({
        owner: context.owner,
        repo: context.repo,
        pullNumber: context.pullNumber,
        title: context.title,
        headSha: context.headSha,
        files: reviewableFiles,
      });

      const outcome = await this.codex.review(prompt);

      if (!outcome.ok) {
        await this.github.publishFailureComment(
          context,
          buildFailureComment({
            headSha: context.headSha,
            reason: outcome.reason,
          }),
        );
        return;
      }

      const event = determineReviewEvent(outcome.result.findings);
      const { comments, overflowFindings } = separateInlineAndOverflowFindings(
        outcome.result.findings,
        reviewableFiles,
      );

      const body = buildReviewBody({
        headSha: context.headSha,
        score: outcome.result.score,
        summary: outcome.result.summary,
        event,
        overflowFindings,
      });
      const fallbackBody = buildReviewBody({
        headSha: context.headSha,
        score: outcome.result.score,
        summary: outcome.result.summary,
        event,
        overflowFindings: outcome.result.findings,
      });

      try {
        await this.github.publishReview({
          context,
          body,
          event,
          comments,
        });
      } catch (error) {
        if (!comments.length || !isInvalidInlineReviewCommentError(error)) {
          throw error;
        }

        this.logger.warn(
          {
            commentCount: comments.length,
            error,
            runKey,
          },
          "Retrying review without inline comments after GitHub rejected the location",
        );

        await this.github.publishReview({
          context,
          body: fallbackBody,
          event,
          comments: [],
        });
      }
    } catch (error) {
      this.logger.error({ error, runKey }, "Pull request review run failed");
      await this.github.publishFailureComment(
        context,
        buildFailureComment({
          headSha: context.headSha,
          reason: "The review pipeline failed before it could submit a review.",
        }),
      );
    } finally {
      this.activeRuns.delete(runKey);
    }
  }

  private async hydrateReviewableFiles(
    context: PullRequestContext,
    changedFiles: GitHubPullRequestFile[],
  ): Promise<ReviewableFile[]> {
    const filteredFiles = filterReviewableFiles(changedFiles);
    const hydratedFiles = await Promise.all(
      filteredFiles.map(async (file) => {
        try {
          const content = await this.github.getFileContent(context, file.path);

          if (!content || !file.patch) {
            return null;
          }

          return {
            path: file.path,
            patch: file.patch,
            content,
          };
        } catch (error) {
          this.logger.warn({ error, path: file.path }, "Skipping unreadable pull request file");
          return null;
        }
      }),
    );

    return hydratedFiles.filter((file): file is ReviewableFile => file !== null);
  }
}
