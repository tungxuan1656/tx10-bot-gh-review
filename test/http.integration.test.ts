import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { Webhooks } from "@octokit/webhooks";

import { createServer } from "../src/http/create-server.js";

describe("createServer", () => {
  it("accepts valid pull_request webhooks", async () => {
    const secret = "super-secret";
    const webhooks = new Webhooks({ secret });
    const payload = JSON.stringify({
      action: "opened",
      installation: { id: 1 },
      repository: { name: "repo", owner: { login: "acme" } },
      pull_request: {
        number: 1,
        title: "Hello",
        html_url: "https://github.com/acme/repo/pull/1",
        head: { sha: "head" },
        base: { sha: "base" },
      },
    });
    const signature = await webhooks.sign(payload);
    const handlePullRequestWebhook = vi.fn().mockResolvedValue(undefined);

    const app = createServer({
      config: { githubWebhookSecret: secret },
      logger: {
        debug: vi.fn(),
      } as never,
      reviewService: {
        handlePullRequestWebhook,
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
    expect(handlePullRequestWebhook).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid signatures", async () => {
    const app = createServer({
      config: { githubWebhookSecret: "secret" },
      logger: {
        debug: vi.fn(),
      } as never,
      reviewService: {
        handlePullRequestWebhook: vi.fn(),
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
  });
});
