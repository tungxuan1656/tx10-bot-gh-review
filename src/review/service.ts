import { determineReviewEvent } from "./decision.js";
import { isCommentableRightSideLine } from "./patch.js";
import { buildReviewPrompt } from "./prompt.js";
import { buildFailureComment, buildReviewBody, buildReviewMarker } from "./summary.js";
import { createChildLogger } from "../logger.js";
import type { AppLogger } from "../logger.js";
import type { CodexRunner } from "./codex.js";
import type { ReviewPlatform } from "./github-platform.js";
import type { NormalizedPullRequestEvent } from "./webhook-event.js";
import type {
  InlineReviewComment,
  PullRequestContext,
  ReviewFinding,
  ReviewableFile,
} from "./types.js";
import type { ReviewWorkspaceManager } from "./workspace.js";

type RoutedPullRequestEvent =
  | {
      status: "trigger_review";
    }
  | {
      status: "cancel_requested";
      reason: "cancel_requested";
    }
  | {
      status: "ignored";
      reason: "manual_only_policy" | "reviewer_mismatch" | "unsupported_action";
    };

function toPullRequestContext(event: NormalizedPullRequestEvent): PullRequestContext {
  return {
    action: event.action,
    installationId: 0,
    owner: event.owner,
    repo: event.repo,
    pullNumber: event.pullNumber,
    title: event.title,
    htmlUrl: event.htmlUrl,
    headSha: event.headSha,
    headRef: event.headRef,
    headCloneUrl: event.headCloneUrl,
    baseSha: event.baseSha,
    baseRef: event.baseRef,
    baseCloneUrl: event.baseCloneUrl,
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
  private readonly cancelRequestedRuns = new Set<string>();

  constructor(
    private readonly github: ReviewPlatform,
    private readonly codex: CodexRunner,
    private readonly workspaceManager: ReviewWorkspaceManager,
    private readonly logger: AppLogger,
    private readonly botLogin: string,
  ) {}

  async handlePullRequestEvent(event: NormalizedPullRequestEvent): Promise<void> {
    const deliveryLogger = this.createDeliveryLogger(event);
    const routedEvent = this.routePullRequestEvent(event);

    deliveryLogger.info(
      {
        beforeSha: event.beforeSha,
        botStillRequested: event.botStillRequested,
        event: "webhook.routed",
        requestedReviewerLogins: event.requestedReviewerLogins,
        status: routedEvent.status,
        ...(routedEvent.status !== "trigger_review" ? { reason: routedEvent.reason } : {}),
      },
      "Webhook routed",
    );

    if (routedEvent.status === "ignored") {
      return;
    }

    if (routedEvent.status === "cancel_requested") {
      this.requestCancellation(event, deliveryLogger);
      return;
    }

    await this.reviewPullRequest(event, deliveryLogger);
  }

  private createDeliveryLogger(event: NormalizedPullRequestEvent): AppLogger {
    return createChildLogger(this.logger, {
      action: event.action,
      component: "review",
      deliveryId: event.deliveryId,
      eventName: event.eventName,
      headSha: event.headSha,
      owner: event.owner,
      pullNumber: event.pullNumber,
      repo: event.repo,
      requestedReviewerLogin: event.requestedReviewerLogin,
      senderLogin: event.senderLogin,
    });
  }

  private routePullRequestEvent(event: NormalizedPullRequestEvent): RoutedPullRequestEvent {
    if (event.actionKind === "review_requested") {
      return event.requestedReviewerLogin === this.botLogin
        ? { status: "trigger_review" }
        : { status: "ignored", reason: "reviewer_mismatch" };
    }

    if (event.actionKind === "review_request_removed") {
      return event.requestedReviewerLogin === this.botLogin
        ? { status: "cancel_requested", reason: "cancel_requested" }
        : { status: "ignored", reason: "reviewer_mismatch" };
    }

    if (event.actionKind === "synchronize") {
      return {
        status: "ignored",
        reason: "manual_only_policy",
      };
    }

    return {
      status: "ignored",
      reason: "unsupported_action",
    };
  }

  private requestCancellation(event: NormalizedPullRequestEvent, deliveryLogger: AppLogger): void {
    const runKey = buildRunKey(toPullRequestContext(event));

    if (!this.activeRuns.has(runKey)) {
      deliveryLogger.info(
        {
          event: "review.cancel_missed",
          reason: "cancel_requested",
          runKey,
          status: "cancel_missed",
        },
        "Review cancel missed",
      );
      return;
    }

    this.cancelRequestedRuns.add(runKey);
    deliveryLogger.info(
      {
        event: "review.cancel_requested",
        reason: "cancel_requested",
        runKey,
        status: "cancel_requested",
      },
      "Review cancel requested",
    );
  }

  private isCancellationRequested(runKey: string): boolean {
    return this.cancelRequestedRuns.has(runKey);
  }

  private shouldStopForCancellation(runLogger: AppLogger, runKey: string, stage: string): boolean {
    if (!this.isCancellationRequested(runKey)) {
      return false;
    }

    runLogger.info(
      {
        event: "review.canceled",
        reason: "canceled_before_publish",
        runKey,
        stage,
        status: "canceled",
      },
      "Review canceled",
    );
    return true;
  }

  private async reviewPullRequest(
    event: NormalizedPullRequestEvent,
    deliveryLogger: AppLogger,
  ): Promise<void> {
    const context = toPullRequestContext(event);
    const runKey = buildRunKey(context);
    const marker = buildReviewMarker(context.headSha);
    const startedAt = Date.now();
    const runLogger = createChildLogger(deliveryLogger, {
      runKey,
    });
    let publishedReview = false;

    runLogger.info(
      {
        event: "review.started",
        status: "started",
      },
      "Review started",
    );

    if (this.activeRuns.has(runKey)) {
      runLogger.info(
        {
          event: "review.completed",
          reason: "duplicate_inflight",
          status: "ignored",
        },
        "Review completed",
      );
      return;
    }

    this.activeRuns.add(runKey);

    try {
      let hasPublishedResult = false;

      try {
        hasPublishedResult = await this.github.hasPublishedResult(context, marker);
      } catch (error) {
        const status = getErrorStatusCode(error);

        if (status === 404) {
          runLogger.warn(
            {
              error,
              event: "review.idempotency_checked",
              httpStatus: status,
              reason: "marker_not_found",
              status: "completed",
            },
            "Review idempotency marker missing",
          );
        } else {
          throw error;
        }
      }

      runLogger.info(
        {
          event: "review.idempotency_checked",
          hasPublishedResult,
          status: "completed",
        },
        "Review idempotency checked",
      );

      if (hasPublishedResult) {
        runLogger.info(
          {
            event: "review.completed",
            reason: "already_published",
            status: "ignored",
          },
          "Review completed",
        );
        return;
      }

      if (this.shouldStopForCancellation(runLogger, runKey, "after_idempotency")) {
        return;
      }

      const workspace = await this.workspaceManager.prepareWorkspace(
        context,
        createChildLogger(runLogger, {
          component: "workspace",
        }),
      );

      try {
        runLogger.info(
          {
            event: "review.workspace_prepared",
            reviewableFileCount: workspace.reviewableFiles.length,
            status: "completed",
            workingDirectory: workspace.workingDirectory,
          },
          "Review workspace prepared",
        );

        if (this.shouldStopForCancellation(runLogger, runKey, "after_workspace_prepare")) {
          return;
        }

        if (workspace.reviewableFiles.length === 0) {
          runLogger.info(
            {
              event: "review.completed",
              reason: "no_reviewable_files",
              status: "ignored",
            },
            "Review completed",
          );
          return;
        }

        const prompt = buildReviewPrompt({
          owner: context.owner,
          repo: context.repo,
          pullNumber: context.pullNumber,
          title: context.title,
          headSha: context.headSha,
          diff: workspace.diff,
          files: workspace.reviewableFiles,
        });

        runLogger.info(
          {
            event: "review.prompt_built",
            promptChars: prompt.length,
            reviewableFileCount: workspace.reviewableFiles.length,
            status: "completed",
          },
          "Review prompt built",
        );

        const outcome = await this.codex.review(
          {
            prompt,
            workingDirectory: workspace.workingDirectory,
          },
          createChildLogger(runLogger, {
            component: "codex",
          }),
        );

        if (!outcome.ok) {
          runLogger.warn(
            {
              event: "review.codex_failed",
              reason: outcome.reason,
              status: "failed",
            },
            "Review Codex step failed",
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

        runLogger.info(
          {
            decision: outcome.result.decision,
            event: "review.codex_completed",
            findingCount: outcome.result.findings.length,
            score: outcome.result.score,
            status: "completed",
          },
          "Review Codex step completed",
        );

        if (this.shouldStopForCancellation(runLogger, runKey, "after_codex")) {
          return;
        }

        const reviewEvent = determineReviewEvent(outcome.result.findings);
        const { comments, overflowFindings } = separateInlineAndOverflowFindings(
          outcome.result.findings,
          workspace.reviewableFiles,
        );

        runLogger.info(
          {
            event: "review.publish_started",
            inlineCommentCount: comments.length,
            overflowFindingCount: overflowFindings.length,
            reviewEvent,
            status: "started",
          },
          "Review publish started",
        );

        if (this.shouldStopForCancellation(runLogger, runKey, "before_publish")) {
          return;
        }

        const body = buildReviewBody({
          headSha: context.headSha,
          score: outcome.result.score,
          summary: outcome.result.summary,
          event: reviewEvent,
          overflowFindings,
        });
        const fallbackBody = buildReviewBody({
          headSha: context.headSha,
          score: outcome.result.score,
          summary: outcome.result.summary,
          event: reviewEvent,
          overflowFindings: outcome.result.findings,
        });

        try {
          await this.github.publishReview({
            context,
            body,
            event: reviewEvent,
            comments,
          });
          publishedReview = true;
          runLogger.info(
            {
              event: "review.published",
              inlineCommentCount: comments.length,
              reviewEvent,
              status: "published",
            },
            "Review published",
          );
        } catch (error) {
          if (!comments.length || !isInvalidInlineReviewCommentError(error)) {
            throw error;
          }

          runLogger.warn(
            {
              commentCount: comments.length,
              error,
              event: "review.publish_fallback",
              reason: "invalid_inline_location",
              status: "retrying",
            },
            "Review publish fallback",
          );

          if (this.shouldStopForCancellation(runLogger, runKey, "before_publish_fallback")) {
            return;
          }

          await this.github.publishReview({
            context,
            body: fallbackBody,
            event: reviewEvent,
            comments: [],
          });
          publishedReview = true;
          runLogger.info(
            {
              event: "review.publish_fallback",
              fallbackMode: true,
              reviewEvent,
              status: "published",
            },
            "Review published",
          );
        }
      } finally {
        await workspace.cleanup();
      }
    } catch (error) {
      runLogger.error(
        {
          error,
          event: "review.failed",
          status: "failed",
        },
        "Review failed",
      );

      try {
        await this.github.publishFailureComment(
          context,
          buildFailureComment({
            headSha: context.headSha,
            reason: "The review pipeline failed before it could submit a review.",
          }),
        );
      } catch (failureCommentError) {
        runLogger.error(
          {
            event: "review.failed",
            failureCommentError,
            originalError: error,
            reason: "failure_comment_failed",
            status: "failed",
          },
          "Review failure comment publish failed",
        );
      }
    } finally {
      if (publishedReview && this.isCancellationRequested(runKey)) {
        runLogger.info(
          {
            event: "review.cancel_missed",
            reason: "cancel_requested",
            status: "cancel_missed",
          },
          "Review cancel missed",
        );
      }

      this.activeRuns.delete(runKey);
      this.cancelRequestedRuns.delete(runKey);
      runLogger.info(
        {
          durationMs: Date.now() - startedAt,
          event: "review.completed",
          status: "completed",
        },
        "Review completed",
      );
    }
  }

}
