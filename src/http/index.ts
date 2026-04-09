import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { createCodexRunner } from "../review/codex.js";
import { createGitHubReviewPlatform } from "../review/github-platform.js";
import { ReviewService } from "../review/service.js";
import { createServer } from "./create-server.js";

const config = loadConfig();
const logger = createLogger(config);

const github = createGitHubReviewPlatform(config);
const codex = createCodexRunner({
  bin: config.codexBin,
  logger,
});
const reviewService = new ReviewService(github, codex, logger, config.githubBotLogin);
const app = createServer({
  config,
  logger,
  reviewService,
});

app.listen(config.port, () => {
  logger.info({ port: config.port }, "GitHub review bot listening");
});
