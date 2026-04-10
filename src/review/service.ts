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
  requested_reviewer: z
    .object({
      login: z.string().min(1),
    })
    .nullable()
    .optional(),
});

function toPullRequestContext(payload: PullRequestWebhookPayload): PullRequestContext {
  return {
    action: payload.action,
    installationId: 0,
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

function getErrorStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const candidate = error as {
    status?: unknown;
  };

  return typeof candidate.status === "number" ? candidate.status : null;
}

export class ReviewService {
  private readonly activeRuns = new Set<string>();

  constructor(
    private readonly github: ReviewPlatform,
    private readonly codex: CodexRunner,
    private readonly logger: AppLogger,
    private readonly botLogin: string,
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

    if (parsed.data.requested_reviewer?.login !== this.botLogin) {
      this.logger.debug(
        {
          action: parsed.data.action,
          owner: parsed.data.repository.owner.login,
          pullNumber: parsed.data.pull_request.number,
          repo: parsed.data.repository.name,
          requestedReviewer: parsed.data.requested_reviewer?.login,
        },
        "Ignored pull_request event for a different reviewer",
      );
      return;
    }

    this.logger.info(
      {
        action: parsed.data.action,
        headSha: parsed.data.pull_request.head.sha,
        owner: parsed.data.repository.owner.login,
        pullNumber: parsed.data.pull_request.number,
        repo: parsed.data.repository.name,
        requestedReviewer: parsed.data.requested_reviewer?.login,
      },
      "Accepted pull_request review request for processing",
    );

    await this.reviewPullRequest({
      ...parsed.data,
      action: parsed.data.action,
    });
  }

  private async reviewPullRequest(payload: PullRequestWebhookPayload): Promise<void> {
    const context = toPullRequestContext(payload);
    const runKey = buildRunKey(context);
    const marker = buildReviewMarker(context.headSha);
    const startedAt = Date.now();

    this.logger.info(
      {
        action: context.action,
        headSha: context.headSha,
        owner: context.owner,
        pullNumber: context.pullNumber,
        repo: context.repo,
        runKey,
      },
      "Review run started",
    );

    if (this.activeRuns.has(runKey)) {
      this.logger.info({ runKey }, "Skipped duplicate in-flight review run");
      return;
    }

    this.activeRuns.add(runKey);

    try {
      let hasPublishedResult = false;

      this.logger.debug({ runKey }, "Checking existing published review marker");

      try {
        hasPublishedResult = await this.github.hasPublishedResult(context, marker);
      } catch (error) {
        const status = getErrorStatusCode(error);

        if (status === 404) {
          this.logger.warn(
            {
              error,
              owner: context.owner,
              pullNumber: context.pullNumber,
              repo: context.repo,
              runKey,
              status,
            },
            "Idempotency check returned not found; continuing review run",
          );
        } else {
          throw error;
        }
      }

      if (hasPublishedResult) {
        this.logger.info({ runKey }, "Skipped already published review result");
        return;
      }

      this.logger.debug({ runKey }, "No published review marker found; continuing pipeline");

      const changedFiles = await this.github.listPullRequestFiles(context);
      this.logger.info(
        {
          changedFileCount: changedFiles.length,
          runKey,
        },
        "Fetched changed files from pull request",
      );

      const reviewableFiles = await this.hydrateReviewableFiles(context, changedFiles, runKey);

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

      this.logger.debug(
        {
          promptChars: prompt.length,
          reviewableFileCount: reviewableFiles.length,
          runKey,
        },
        "Built review prompt for Codex",
      );

      const outcome = await this.codex.review(prompt);

      if (!outcome.ok) {
        this.logger.warn(
          {
            reason: outcome.reason,
            runKey,
          },
          "Codex review failed; publishing neutral failure comment",
        );

        await this.github.publishFailureComment(
          context,
          buildFailureComment({
            headSha: context.headSha,
            reason: outcome.reason,
          }),
        );
        return;
      }

      this.logger.info(
        {
          decision: outcome.result.decision,
          findingCount: outcome.result.findings.length,
          runKey,
          score: outcome.result.score,
        },
        "Codex review completed with valid result",
      );

      const event = determineReviewEvent(outcome.result.findings);
      const { comments, overflowFindings } = separateInlineAndOverflowFindings(
        outcome.result.findings,
        reviewableFiles,
      );

      this.logger.info(
        {
          event,
          inlineCommentCount: comments.length,
          overflowFindingCount: overflowFindings.length,
          runKey,
        },
        "Publishing pull request review",
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
        this.logger.info(
          {
            event,
            inlineCommentCount: comments.length,
            runKey,
          },
          "Published pull request review",
        );
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
        this.logger.info(
          {
            event,
            fallbackMode: true,
            runKey,
          },
          "Published pull request review without inline comments",
        );
      }
    } catch (error) {
      this.logger.error({ error, runKey }, "Pull request review run failed");

      try {
        await this.github.publishFailureComment(
          context,
          buildFailureComment({
            headSha: context.headSha,
            reason: "The review pipeline failed before it could submit a review.",
          }),
        );
      } catch (failureCommentError) {
        this.logger.error(
          {
            failureCommentError,
            originalError: error,
            runKey,
          },
          "Failed to publish fallback failure comment",
        );
      }
    } finally {
      this.activeRuns.delete(runKey);
      this.logger.info(
        {
          durationMs: Date.now() - startedAt,
          runKey,
        },
        "Review run completed",
      );
    }
  }

  private async hydrateReviewableFiles(
    context: PullRequestContext,
    changedFiles: GitHubPullRequestFile[],
    runKey: string,
  ): Promise<ReviewableFile[]> {
    const filteredFiles = filterReviewableFiles(changedFiles);

    this.logger.debug(
      {
        changedFileCount: changedFiles.length,
        filteredFileCount: filteredFiles.length,
        runKey,
      },
      "Filtered pull request files for review",
    );

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
          this.logger.warn(
            {
              error,
              path: file.path,
              runKey,
            },
            "Skipping unreadable pull request file",
          );
          return null;
        }
      }),
    );

    const reviewableFiles = hydratedFiles.filter((file): file is ReviewableFile => file !== null);

    this.logger.info(
      {
        reviewableFileCount: reviewableFiles.length,
        runKey,
        skippedFileCount: hydratedFiles.length - reviewableFiles.length,
      },
      "Hydrated reviewable files with patch and content",
    );

    return reviewableFiles;
  }
}
