import { loadConfig } from '../config.js'
import { createLogger } from '../logger.js'
import { createCodexRunner } from '../review/codex.js'
import { createGitHubReviewPlatform } from '../review/github-platform.js'
import { ReviewService } from '../review/service.js'
import { createTemporaryReviewWorkspaceManager } from '../review/workspace.js'
import { createServer } from './create-server.js'

const config = loadConfig()
const logger = createLogger(config)

const github = createGitHubReviewPlatform(config)
const codex = createCodexRunner({
  bin: config.codexBin,
  logger,
  timeoutMs: config.codexTimeoutMs,
})
const workspaceManager = createTemporaryReviewWorkspaceManager({
  githubToken: config.githubToken,
  logger,
})
const reviewService = new ReviewService(
  github,
  codex,
  workspaceManager,
  logger,
  config.githubBotLogin,
  {
    approvedLockEnabled: config.reviewApprovedLockEnabled,
    discussionCacheDirectory: config.reviewDiscussionCacheDir,
    discussionCacheTtlMs: config.reviewDiscussionCacheTtlMs,
  },
)
const app = createServer({
  config,
  logger,
  reviewService,
})

app.listen(config.port, () => {
  logger.info({ port: config.port }, 'GitHub review bot listening')
})
