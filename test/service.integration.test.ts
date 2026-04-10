import { describe, expect, it, vi } from "vitest";

import { ReviewService } from "../src/review/service.js";
import type { CodexRunner } from "../src/review/codex.js";
import type { ReviewPlatform } from "../src/review/github-platform.js";
import type { AppLogger } from "../src/logger.js";
import type { NormalizedPullRequestEvent } from "../src/review/webhook-event.js";

function createLoggerStub(): AppLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as AppLogger;
}

function createPullRequestEvent(
  overrides: Partial<NormalizedPullRequestEvent> = {},
): NormalizedPullRequestEvent {
  return {
    action: "review_requested",
    actionKind: "review_requested",
    afterSha: null,
    baseSha: "def456",
    beforeSha: null,
    botStillRequested: null,
    deliveryId: "delivery-123",
    eventName: "pull_request",
    headSha: "abc123",
    htmlUrl: "https://github.com/acme/repo/pull/42",
    owner: "acme",
    pullNumber: 42,
    repo: "repo",
    requestedReviewerLogin: "review-bot",
    requestedReviewerLogins: ["review-bot"],
    senderLogin: "octocat",
    title: "Add a review flow",
    ...overrides,
  };
}

function createGitHubPlatform(overrides: Partial<ReviewPlatform> = {}) {
  const baseMocks = {
    getFileContent: vi.fn().mockResolvedValue("console.log('b');"),
    hasPublishedResult: vi.fn().mockResolvedValue(false),
    listPullRequestFiles: vi.fn().mockResolvedValue([
      {
        path: "src/app.ts",
        status: "modified",
        patch: "@@ -1 +1 @@\n-console.log('a')\n+console.log('b')",
      },
    ]),
    publishFailureComment: vi.fn().mockResolvedValue(undefined),
    publishReview: vi.fn().mockResolvedValue(undefined),
  };
  const mocks = {
    ...baseMocks,
    ...overrides,
  };

  return {
    mocks,
    platform: mocks satisfies ReviewPlatform,
  };
}

function createSuccessfulCodexReview(): CodexRunner["review"] {
  return vi.fn(() =>
    Promise.resolve({
      ok: true,
      result: {
        summary: "Found one issue.",
        score: 6,
        decision: "request_changes",
        findings: [
          {
            severity: "high",
            path: "src/app.ts",
            line: 1,
            title: "Console statement committed",
            comment: "Use the structured logger instead.",
          },
        ],
      },
    }),
  ) as CodexRunner["review"];
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, reject, resolve };
}

describe("ReviewService", () => {
  it("publishes a review for a valid Codex result", async () => {
    const github = createGitHubPlatform();
    const codex: CodexRunner = {
      review: createSuccessfulCodexReview(),
    };

    const service = new ReviewService(github.platform, codex, createLoggerStub(), "review-bot");
    await service.handlePullRequestEvent(createPullRequestEvent());

    expect(github.mocks.publishReview).toHaveBeenCalledTimes(1);
    expect(github.mocks.publishFailureComment).not.toHaveBeenCalled();
  });

  it("emits lifecycle logs for a successful review run", async () => {
    const github = createGitHubPlatform();
    const codex: CodexRunner = {
      review: vi.fn().mockResolvedValue({
        ok: true,
        result: {
          summary: "No issues.",
          score: 9,
          decision: "approve",
          findings: [],
        },
      }),
    };
    const logger = createLoggerStub();

    const service = new ReviewService(github.platform, codex, logger, "review-bot");
    await service.handlePullRequestEvent(createPullRequestEvent());

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "review_requested",
        deliveryId: "delivery-123",
        event: "webhook.routed",
        headSha: "abc123",
        owner: "acme",
        pullNumber: 42,
        repo: "repo",
        status: "trigger_review",
      }),
      "Webhook routed",
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-123",
        event: "review.started",
        runKey: "acme/repo#42@abc123",
        status: "started",
      }),
      "Review started",
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-123",
        event: "review.completed",
        runKey: "acme/repo#42@abc123",
        status: "completed",
      }),
      "Review completed",
    );
  });

  it("publishes a neutral failure comment when Codex fails", async () => {
    const github = createGitHubPlatform();
    const codex: CodexRunner = {
      review: vi.fn().mockResolvedValue({
        ok: false,
        reason: "Codex returned a non-zero exit code.",
      }),
    };

    const service = new ReviewService(github.platform, codex, createLoggerStub(), "review-bot");
    await service.handlePullRequestEvent(createPullRequestEvent());

    expect(github.mocks.publishReview).not.toHaveBeenCalled();
    expect(github.mocks.publishFailureComment).toHaveBeenCalledTimes(1);
  });

  it("skips duplicate head SHA results", async () => {
    const github = createGitHubPlatform({
      hasPublishedResult: vi.fn().mockResolvedValue(true),
      listPullRequestFiles: vi.fn(),
    });
    const review = vi.fn();
    const codex: CodexRunner = {
      review,
    };

    const service = new ReviewService(github.platform, codex, createLoggerStub(), "review-bot");
    await service.handlePullRequestEvent(createPullRequestEvent());

    expect(github.mocks.listPullRequestFiles).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it("continues review when idempotency check returns not found", async () => {
    const github = createGitHubPlatform({
      hasPublishedResult: vi.fn().mockRejectedValue({
        status: 404,
        message: "Not Found",
      }),
    });
    const review = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        summary: "No actionable issues.",
        score: 9,
        decision: "approve",
        findings: [],
      },
    });
    const codex: CodexRunner = {
      review,
    };

    const service = new ReviewService(github.platform, codex, createLoggerStub(), "review-bot");
    await service.handlePullRequestEvent(createPullRequestEvent());

    expect(github.mocks.listPullRequestFiles).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(1);
    expect(github.mocks.publishReview).toHaveBeenCalledTimes(1);
    expect(github.mocks.publishFailureComment).not.toHaveBeenCalled();
  });

  it("publishes neutral failure comment when idempotency check is forbidden", async () => {
    const github = createGitHubPlatform({
      hasPublishedResult: vi.fn().mockRejectedValue({
        status: 403,
        message: "Forbidden",
      }),
      listPullRequestFiles: vi.fn(),
    });
    const review = vi.fn();
    const codex: CodexRunner = {
      review,
    };

    const service = new ReviewService(github.platform, codex, createLoggerStub(), "review-bot");
    await service.handlePullRequestEvent(createPullRequestEvent());

    expect(github.mocks.listPullRequestFiles).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(github.mocks.publishReview).not.toHaveBeenCalled();
    expect(github.mocks.publishFailureComment).toHaveBeenCalledTimes(1);
  });

  it("does not throw when fallback failure comment publishing also fails", async () => {
    const github = createGitHubPlatform({
      hasPublishedResult: vi.fn().mockRejectedValue({
        status: 403,
        message: "Forbidden",
      }),
      listPullRequestFiles: vi.fn(),
      publishFailureComment: vi.fn().mockRejectedValue(new Error("comment publish failed")),
    });
    const review = vi.fn();
    const codex: CodexRunner = {
      review,
    };
    const logger = createLoggerStub();

    const service = new ReviewService(github.platform, codex, logger, "review-bot");

    await expect(
      service.handlePullRequestEvent(createPullRequestEvent()),
    ).resolves.toBeUndefined();

    expect(github.mocks.publishFailureComment).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("skips unreadable files and still reviews the remaining diff", async () => {
    const github = createGitHubPlatform({
      getFileContent: vi
        .fn()
        .mockRejectedValueOnce(new Error("not found"))
        .mockResolvedValueOnce("export const value = 'new';"),
      listPullRequestFiles: vi.fn().mockResolvedValue([
        {
          path: "src/bad.ts",
          status: "modified",
          patch: "@@ -1 +1 @@\n-a\n+b",
        },
        {
          path: "src/good.ts",
          status: "modified",
          patch: "@@ -1 +1 @@\n-old\n+new",
        },
      ]),
    });
    const review = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        summary: "No actionable issues.",
        score: 9,
        decision: "approve",
        findings: [],
      },
    });
    const codex: CodexRunner = { review };

    const service = new ReviewService(github.platform, codex, createLoggerStub(), "review-bot");
    await service.handlePullRequestEvent(createPullRequestEvent());

    expect(review).toHaveBeenCalledTimes(1);
    expect(github.mocks.publishReview).toHaveBeenCalledTimes(1);
    expect(github.mocks.publishFailureComment).not.toHaveBeenCalled();
  });

  it("retries with a body-only review when GitHub rejects inline comment locations", async () => {
    const publishReviewMock = vi
      .fn()
      .mockRejectedValueOnce({
        status: 422,
        message: "Review comments is invalid.",
        errors: [
          {
            resource: "PullRequestReviewComment",
            field: "line",
            code: "invalid",
          },
        ],
      })
      .mockResolvedValueOnce(undefined);
    const github = createGitHubPlatform({
      publishReview: publishReviewMock,
    });
    const codex: CodexRunner = {
      review: createSuccessfulCodexReview(),
    };

    const service = new ReviewService(github.platform, codex, createLoggerStub(), "review-bot");
    await service.handlePullRequestEvent(createPullRequestEvent());

    const firstPublishInput = publishReviewMock.mock.calls[0]?.[0] as {
      body: string;
      comments: unknown[];
    };
    const secondPublishInput = publishReviewMock.mock.calls[1]?.[0] as {
      body: string;
      comments: unknown[];
    };

    expect(publishReviewMock).toHaveBeenCalledTimes(2);
    expect(firstPublishInput.comments).toHaveLength(1);
    expect(secondPublishInput.comments).toEqual([]);
    expect(secondPublishInput.body).toContain("### Additional findings");
    expect(secondPublishInput.body).toContain("Console statement committed");
    expect(github.mocks.publishFailureComment).not.toHaveBeenCalled();
  });

  it("ignores review requests for a different reviewer", async () => {
    const github = createGitHubPlatform({
      listPullRequestFiles: vi.fn(),
    });
    const review = vi.fn();
    const codex: CodexRunner = { review };
    const logger = createLoggerStub();

    const service = new ReviewService(github.platform, codex, logger, "review-bot");
    await service.handlePullRequestEvent(
      createPullRequestEvent({
        requestedReviewerLogin: "someone-else",
        requestedReviewerLogins: ["someone-else"],
      }),
    );

    expect(github.mocks.listPullRequestFiles).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(github.mocks.publishReview).not.toHaveBeenCalled();
    expect(github.mocks.publishFailureComment).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "webhook.routed",
        reason: "reviewer_mismatch",
        status: "ignored",
      }),
      "Webhook routed",
    );
  });

  it("ignores synchronize events under the manual-only policy and logs botStillRequested", async () => {
    const github = createGitHubPlatform({
      listPullRequestFiles: vi.fn(),
    });
    const review = vi.fn();
    const codex: CodexRunner = { review };
    const logger = createLoggerStub();

    const service = new ReviewService(github.platform, codex, logger, "review-bot");
    await service.handlePullRequestEvent(
      createPullRequestEvent({
        action: "synchronize",
        actionKind: "synchronize",
        afterSha: "abc123",
        beforeSha: "000000",
        botStillRequested: true,
        requestedReviewerLogin: null,
      }),
    );

    expect(github.mocks.listPullRequestFiles).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        botStillRequested: true,
        event: "webhook.routed",
        reason: "manual_only_policy",
        status: "ignored",
      }),
      "Webhook routed",
    );
  });

  it("cancels an in-flight review after review_request_removed arrives", async () => {
    const hasPublishedResultDeferred = createDeferred<boolean>();
    const github = createGitHubPlatform({
      hasPublishedResult: vi.fn().mockImplementation(() => hasPublishedResultDeferred.promise),
      listPullRequestFiles: vi.fn(),
      publishReview: vi.fn(),
    });
    const review = vi.fn();
    const codex: CodexRunner = { review };
    const logger = createLoggerStub();
    const service = new ReviewService(github.platform, codex, logger, "review-bot");

    const runPromise = service.handlePullRequestEvent(createPullRequestEvent());
    await Promise.resolve();

    await service.handlePullRequestEvent(
      createPullRequestEvent({
        action: "review_request_removed",
        actionKind: "review_request_removed",
        requestedReviewerLogins: [],
      }),
    );

    hasPublishedResultDeferred.resolve(false);
    await runPromise;

    expect(github.mocks.listPullRequestFiles).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(github.mocks.publishReview).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "review.cancel_requested",
        reason: "cancel_requested",
        runKey: "acme/repo#42@abc123",
        status: "cancel_requested",
      }),
      "Review cancel requested",
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "review.canceled",
        reason: "canceled_before_publish",
        runKey: "acme/repo#42@abc123",
        status: "canceled",
      }),
      "Review canceled",
    );
  });

  it("ignores unsupported pull_request actions", async () => {
    const github = createGitHubPlatform({
      listPullRequestFiles: vi.fn(),
    });
    const review = vi.fn();
    const codex: CodexRunner = { review };
    const logger = createLoggerStub();

    const service = new ReviewService(github.platform, codex, logger, "review-bot");
    await service.handlePullRequestEvent(
      createPullRequestEvent({
        action: "opened",
        actionKind: "other_pull_request_action",
      }),
    );

    expect(github.mocks.listPullRequestFiles).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "webhook.routed",
        reason: "unsupported_action",
        status: "ignored",
      }),
      "Webhook routed",
    );
  });
});
