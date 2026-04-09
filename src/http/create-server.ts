import express from "express";
import { Webhooks } from "@octokit/webhooks";

import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import type { ReviewService } from "../review/service.js";

export function createServer(input: {
  config: Pick<AppConfig, "githubWebhookSecret">;
  logger: AppLogger;
  reviewService: ReviewService;
}) {
  const app = express();
  const webhooks = new Webhooks({
    secret: input.config.githubWebhookSecret,
  });

  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  app.post(
    "/github/webhooks",
    express.raw({
      type: "application/json",
      limit: "2mb",
    }),
    async (request, response) => {
      const eventName = request.header("x-github-event");
      const signature = request.header("x-hub-signature-256");
      const deliveryId = request.header("x-github-delivery");
      const body = Buffer.isBuffer(request.body)
        ? request.body.toString("utf8")
        : JSON.stringify(request.body ?? {});

      if (!eventName || !signature || !deliveryId) {
        response.status(400).json({ error: "Missing GitHub webhook headers." });
        return;
      }

      const isValid = await webhooks.verify(body, signature);
      if (!isValid) {
        response.status(401).json({ error: "Invalid webhook signature." });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        response.status(400).json({ error: "Invalid JSON payload." });
        return;
      }

      if (eventName === "pull_request") {
        void input.reviewService.handlePullRequestWebhook(payload);
      } else {
        input.logger.debug({ eventName }, "Ignored unsupported webhook event");
      }

      response.status(202).json({ status: "accepted" });
    },
  );

  return app;
}
