import type { AppLogger } from '../../types/app.js'
import type { CodexRunner } from './codex.js'
import type {
  PriorSuccessfulReviewInfo,
  PullRequestContext,
} from './core.js'
import type { DiscussionCacheOptions } from './discussion.js'
import type { NormalizedPullRequestEvent } from './events.js'
import type { ReviewPlatform } from './github.js'
import type { ActiveRun, ActiveRunRef } from './queue.js'
import type {
  PreparedReviewWorkspace,
  ReviewWorkspaceManager,
} from './workspace.js'
import type { ReviewMode } from './helpers.js'
import type { ReviewQueueManager } from '../review-queue.js'

export type ReviewWorkflowInput = {
  approvedLockEnabled: boolean
  approvedLockedPullRequests: Set<string>
  codex: CodexRunner
  context: PullRequestContext
  deliveryId: string
  github: ReviewPlatform
  priorSuccessfulReview: PriorSuccessfulReviewInfo
  queueManager: ReviewQueueManager
  reviewMode: ReviewMode
  run: ActiveRun
  runLogger: AppLogger
  workspace: PreparedReviewWorkspace
}

export type ReviewExecutionInput = {
  approvedLockEnabled: boolean
  approvedLockedPullRequests: Set<string>
  codex: CodexRunner
  discussionCacheOptions: DiscussionCacheOptions
  event: NormalizedPullRequestEvent
  github: ReviewPlatform
  queueManager: ReviewQueueManager
  activeRunRef: ActiveRunRef
  workspaceManager: ReviewWorkspaceManager
  deliveryLogger: AppLogger
}

export type ReviewServiceOptions = {
  approvedLockEnabled?: boolean
  discussionCacheDirectory?: string
  discussionCacheTtlMs?: number
}
