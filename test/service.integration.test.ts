import { describe, expect, it, vi } from "vitest";

import { ReviewService } from "../src/review/service.js";
import type { CodexRunner } from "../src/review/codex.js";
import type { ReviewPlatform } from "../src/review/github-platform.js";
import type { AppLogger } from "../src/logger.js";

function createLoggerStub(): AppLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as AppLogger;
}

function createPullRequestPayload() {
  return {
    action: "opened",
    installation: {
      id: 1,
    },
    repository: {
      name: "repo",
      owner: {
        login: "acme",
      },
    },
    pull_request: {
      number: 42,
      title: "Add a review flow",
      html_url: "https://github.com/acme/repo/pull/42",
      head: {
        sha: "abc123",
      },
      base: {
        sha: "def456",
      },
    },
  };
}

describe("ReviewService", () => {
  it("publishes a review for a valid Codex result", async () => {
    const hasPublishedResult = vi.fn().mockResolvedValue(false);
    const listPullRequestFiles = vi.fn().mockResolvedValue([
      {
        path: "src/app.ts",
        status: "modified",
        patch: "@@ -1 +1 @@\n-console.log('a')\n+console.log('b')",
      },
    ]);
    const getFileContent = vi.fn().mockResolvedValue("console.log('b');");
    const publishReview = vi.fn().mockResolvedValue(undefined);
    const publishFailureComment = vi.fn().mockResolvedValue(undefined);
    const github: ReviewPlatform = {
      hasPublishedResult,
      listPullRequestFiles,
      getFileContent,
      publishReview,
      publishFailureComment,
    };

    const codex: CodexRunner = {
      review: vi.fn().mockResolvedValue({
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
    };

    const service = new ReviewService(github, codex, createLoggerStub());
    await service.handlePullRequestWebhook(createPullRequestPayload());

    expect(publishReview).toHaveBeenCalledTimes(1);
    expect(publishFailureComment).not.toHaveBeenCalled();
  });

  it("publishes a neutral failure comment when Codex fails", async () => {
    const hasPublishedResult = vi.fn().mockResolvedValue(false);
    const listPullRequestFiles = vi.fn().mockResolvedValue([
      {
        path: "src/app.ts",
        status: "modified",
        patch: "@@ -1 +1 @@\n-console.log('a')\n+console.log('b')",
      },
    ]);
    const getFileContent = vi.fn().mockResolvedValue("console.log('b');");
    const publishReview = vi.fn().mockResolvedValue(undefined);
    const publishFailureComment = vi.fn().mockResolvedValue(undefined);
    const github: ReviewPlatform = {
      hasPublishedResult,
      listPullRequestFiles,
      getFileContent,
      publishReview,
      publishFailureComment,
    };

    const codex: CodexRunner = {
      review: vi.fn().mockResolvedValue({
        ok: false,
        reason: "Codex returned a non-zero exit code.",
      }),
    };

    const service = new ReviewService(github, codex, createLoggerStub());
    await service.handlePullRequestWebhook(createPullRequestPayload());

    expect(publishReview).not.toHaveBeenCalled();
    expect(publishFailureComment).toHaveBeenCalledTimes(1);
  });

  it("skips duplicate head SHA results", async () => {
    const hasPublishedResult = vi.fn().mockResolvedValue(true);
    const listPullRequestFiles = vi.fn();
    const getFileContent = vi.fn();
    const publishReview = vi.fn();
    const publishFailureComment = vi.fn();
    const github: ReviewPlatform = {
      hasPublishedResult,
      listPullRequestFiles,
      getFileContent,
      publishReview,
      publishFailureComment,
    };

    const review = vi.fn();
    const codex: CodexRunner = {
      review,
    };

    const service = new ReviewService(github, codex, createLoggerStub());
    await service.handlePullRequestWebhook(createPullRequestPayload());

    expect(listPullRequestFiles).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it("skips unreadable files and still reviews the remaining diff", async () => {
    const hasPublishedResult = vi.fn().mockResolvedValue(false);
    const listPullRequestFiles = vi.fn().mockResolvedValue([
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
    ]);
    const getFileContent = vi
      .fn()
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce("export const value = 'new';");
    const publishReview = vi.fn().mockResolvedValue(undefined);
    const publishFailureComment = vi.fn().mockResolvedValue(undefined);
    const review = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        summary: "No actionable issues.",
        score: 9,
        decision: "approve",
        findings: [],
      },
    });

    const github: ReviewPlatform = {
      hasPublishedResult,
      listPullRequestFiles,
      getFileContent,
      publishReview,
      publishFailureComment,
    };
    const codex: CodexRunner = { review };

    const service = new ReviewService(github, codex, createLoggerStub());
    await service.handlePullRequestWebhook(createPullRequestPayload());

    expect(review).toHaveBeenCalledTimes(1);
    expect(publishReview).toHaveBeenCalledTimes(1);
    expect(publishFailureComment).not.toHaveBeenCalled();
  });

  it("retries with a body-only review when GitHub rejects inline comment locations", async () => {
    const hasPublishedResult = vi.fn().mockResolvedValue(false);
    const listPullRequestFiles = vi.fn().mockResolvedValue([
      {
        path: "src/app.ts",
        status: "modified",
        patch: "@@ -1 +1 @@\n-console.log('a')\n+console.log('b')",
      },
    ]);
    const getFileContent = vi.fn().mockResolvedValue("console.log('b');");
    const publishReview = vi
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
    const publishFailureComment = vi.fn().mockResolvedValue(undefined);
    const github: ReviewPlatform = {
      hasPublishedResult,
      listPullRequestFiles,
      getFileContent,
      publishReview,
      publishFailureComment,
    };

    const codex: CodexRunner = {
      review: vi.fn().mockResolvedValue({
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
    };

    const service = new ReviewService(github, codex, createLoggerStub());
    await service.handlePullRequestWebhook(createPullRequestPayload());

    const firstPublishInput = publishReview.mock.calls[0]?.[0] as {
      body: string;
      comments: unknown[];
    };
    const secondPublishInput = publishReview.mock.calls[1]?.[0] as {
      body: string;
      comments: unknown[];
    };

    expect(publishReview).toHaveBeenCalledTimes(2);
    expect(firstPublishInput.comments).toHaveLength(1);
    expect(secondPublishInput.comments).toEqual([]);
    expect(secondPublishInput.body).toContain("### Additional findings");
    expect(secondPublishInput.body).toContain("Console statement committed");
    expect(publishFailureComment).not.toHaveBeenCalled();
  });
});
