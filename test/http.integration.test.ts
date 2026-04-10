import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { Webhooks } from "@octokit/webhooks";

import { createServer } from "../src/http/create-server.js";

describe("createServer", () => {
  it("accepts valid pull_request webhooks and forwards a normalized event", async () => {
    const secret = "super-secret";
    const webhooks = new Webhooks({ secret });
    const payload = JSON.stringify({
      action: "review_requested",
      repository: {
        name: "repo",
        clone_url: "https://github.com/acme/repo.git",
        owner: { login: "acme" },
      },
      pull_request: {
        number: 1,
        title: "Hello",
        html_url: "https://github.com/acme/repo/pull/1",
        head: {
          ref: "feature/hello",
          sha: "head",
          repo: {
            clone_url: "https://github.com/acme/repo.git",
          },
        },
        base: {
          ref: "main",
          sha: "base",
          repo: {
            clone_url: "https://github.com/acme/repo.git",
          },
        },
        requested_reviewers: [{ login: "review-bot" }],
      },
      requested_reviewer: {
        login: "review-bot",
      },
      sender: {
        login: "octocat",
      },
    });
    const signature = await webhooks.sign(payload);
    const handlePullRequestEvent = vi.fn().mockResolvedValue(undefined);
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    const app = createServer({
      config: {
        githubBotLogin: "review-bot",
        githubWebhookSecret: secret,
      },
      logger: logger as never,
      reviewService: {
        handlePullRequestEvent,
      } as never,
    });

    const response = await request(app)
      .post("/github/webhooks")
      .set("content-type", "application/json")
      .set("x-github-event", "pull_request")
      .set("x-github-delivery", "123")
      .set("x-hub-signature-256", signature)
      .send(payload);

    expect(response.status).toBe(202);
    expect(handlePullRequestEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "review_requested",
        actionKind: "review_requested",
        deliveryId: "123",
        headSha: "head",
        headRef: "feature/hello",
        owner: "acme",
        pullNumber: 1,
        repo: "repo",
        baseRef: "main",
        requestedReviewerLogin: "review-bot",
        senderLogin: "octocat",
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "review_requested",
        component: "http",
        deliveryId: "123",
        event: "webhook.received",
        headSha: "head",
        owner: "acme",
        pullNumber: 1,
        repo: "repo",
        status: "received",
      }),
      "Webhook received",
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "review_requested",
        component: "http",
        deliveryId: "123",
        event: "webhook.verified",
        status: "verified",
      }),
      "Webhook verified",
    );
  });

  it("rejects invalid signatures", async () => {
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    const app = createServer({
      config: {
        githubBotLogin: "review-bot",
        githubWebhookSecret: "secret",
      },
      logger: logger as never,
      reviewService: {
        handlePullRequestEvent: vi.fn(),
      } as never,
    });

    const response = await request(app)
      .post("/github/webhooks")
      .set("content-type", "application/json")
      .set("x-github-event", "pull_request")
      .set("x-github-delivery", "123")
      .set("x-hub-signature-256", "sha256=bad")
      .send("{}");

    expect(response.status).toBe(401);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "http",
        deliveryId: "123",
        event: "webhook.rejected",
        reason: "invalid_signature",
        status: "rejected",
      }),
      "Webhook rejected",
    );
  });
});
