import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const baseEnv = {
  NODE_ENV: "test",
  PORT: "43191",
  GITHUB_APP_ID: "123",
  GITHUB_PRIVATE_KEY: "line-1\\nline-2",
  GITHUB_WEBHOOK_SECRET: "secret",
  CODEX_BIN: "codex",
  LOG_LEVEL: "info",
} satisfies NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("omits githubInstallationId when the env var is missing", () => {
    const config = loadConfig(baseEnv);

    expect(config.githubInstallationId).toBeUndefined();
  });

  it("treats an empty github installation id as undefined", () => {
    const config = loadConfig({
      ...baseEnv,
      GITHUB_INSTALLATION_ID: "",
    });

    expect(config.githubInstallationId).toBeUndefined();
  });

  it("parses a provided github installation id", () => {
    const config = loadConfig({
      ...baseEnv,
      GITHUB_INSTALLATION_ID: "99",
    });

    expect(config.githubInstallationId).toBe(99);
  });
});
