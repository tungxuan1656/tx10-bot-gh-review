import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const baseEnv = {
  NODE_ENV: "test",
  PORT: "43191",
  GITHUB_TOKEN: "ghp_test_token",
  GITHUB_BOT_LOGIN: "review-bot",
  GITHUB_WEBHOOK_SECRET: "secret",
  CODEX_BIN: "codex",
  LOG_LEVEL: "info",
} satisfies NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("loads the required GitHub machine-user settings", () => {
    const config = loadConfig(baseEnv);

    expect(config.githubToken).toBe("ghp_test_token");
    expect(config.githubBotLogin).toBe("review-bot");
  });
});
