import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { determineReviewDecision, toReviewEvent } from './decision.js'
import { isCommentableRightSideLine } from './patch.js'
import {
  buildPhase1Prompt,
  buildPhase2Prompt,
  buildPhase3Prompt,
} from './prompt.js'
import {
  buildFailureComment,
  buildReviewBody,
  buildReviewMarker,
} from './summary.js'
import { createChildLogger } from '../logger.js'
import type { AppLogger } from '../logger.js'
import type { CodexRunner } from './codex.js'
import type { ReviewPlatform } from './github-platform.js'
import type { NormalizedPullRequestEvent } from './webhook-event.js'
import type {
  InlineReviewComment,
  PRInfoObject,
  PullRequestContext,
  ReviewDecision,
  ReviewFinding,
  ReviewableFile,
} from './types.js'
import type { ReviewWorkspaceManager } from './workspace.js'

type RoutedPullRequestEvent =
  | {
      status: 'trigger_review'
      reason: 'review_requested' | 'synchronize'
    }
  | {
      status: 'cancel_requested'
      reason: 'cancel_requested'
    }
  | {
      status: 'ignored'
      reason: 'bot_not_requested' | 'reviewer_mismatch' | 'unsupported_action'
    }

type QueueCancelReason = 'cancel_requested' | 'superseded_by_new_commit'

type QueueRequest = {
  enqueuedAt: number
  completion: Promise<void>
  event: NormalizedPullRequestEvent
  resolveCompletion: () => void
}

type ActiveRun = {
  abortController: AbortController
  cancellationLogged: boolean
  cancellationReason: QueueCancelReason | null
  context: PullRequestContext
  pullRequestKey: string
  runKey: string
}

type ReviewServiceOptions = {
  approvedLockEnabled?: boolean
  discussionCacheDirectory?: string
  discussionCacheTtlMs?: number
}

const reviewCommentsFileName = 'pr-review-comments.md'
const defaultDiscussionCacheDirectory = path.join(
  os.tmpdir(),
  'tx10-review-discussions',
)
const defaultDiscussionCacheTtlMs = 7 * 24 * 60 * 60 * 1_000

function createCompletion(): {
  completion: Promise<void>
  resolveCompletion: () => void
} {
  let resolveCompletion!: () => void

  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })

  return {
    completion,
    resolveCompletion,
  }
}

function toPullRequestContext(
  event: NormalizedPullRequestEvent,
): PullRequestContext {
  return {
    action: event.action,
    installationId: 0,
    owner: event.owner,
    repo: event.repo,
    pullNumber: event.pullNumber,
    title: event.title,
    htmlUrl: event.htmlUrl,
    headSha: event.headSha,
    headRef: event.headRef,
    headCloneUrl: event.headCloneUrl,
    baseSha: event.baseSha,
    baseRef: event.baseRef,
    baseCloneUrl: event.baseCloneUrl,
  }
}

function buildRunKey(context: PullRequestContext): string {
  return `${context.owner}/${context.repo}#${context.pullNumber}@${context.headSha}`
}

function buildPullRequestKey(context: PullRequestContext): string {
  return `${context.owner}/${context.repo}#${context.pullNumber}`
}

function toInlineComment(finding: ReviewFinding): string {
  return [
    `**${finding.severity.toUpperCase()}**: ${finding.title}`,
    '',
    finding.comment,
  ].join('\n')
}

function separateInlineAndOverflowFindings(
  findings: ReviewFinding[],
  files: ReviewableFile[],
): {
  comments: InlineReviewComment[]
  overflowFindings: ReviewFinding[]
} {
  const filesByPath = new Map(files.map((file) => [file.path, file]))
  const comments: InlineReviewComment[] = []
  const overflowFindings: ReviewFinding[] = []

  for (const finding of findings) {
    const file = filesByPath.get(finding.path)

    if (!file || !isCommentableRightSideLine(file.patch, finding.line)) {
      overflowFindings.push(finding)
      continue
    }

    comments.push({
      path: finding.path,
      line: finding.line,
      side: 'RIGHT',
      body: toInlineComment(finding),
    })
  }

  return { comments, overflowFindings }
}

function isInvalidInlineReviewCommentError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const candidate = error as {
    errors?: Array<{
      code?: string
      field?: string
      message?: string
      resource?: string
    }>
    message?: string
    status?: number
  }

  if (candidate.status !== 422) {
    return false
  }

  const lowerCaseMessage = candidate.message?.toLowerCase() ?? ''
  if (
    lowerCaseMessage.includes('review comments is invalid') ||
    lowerCaseMessage.includes('review threads is invalid')
  ) {
    return true
  }

  return (candidate.errors ?? []).some((validationError) => {
    const resource = validationError.resource?.toLowerCase()
    const field = validationError.field?.toLowerCase()
    const message = validationError.message?.toLowerCase() ?? ''

    return (
      resource === 'pullrequestreviewcomment' ||
      resource === 'pullrequestreviewthread' ||
      field === 'line' ||
      field === 'side' ||
      field === 'start_line' ||
      field === 'start_side' ||
      field === 'path' ||
      message.includes('review comment') ||
      message.includes('review thread')
    )
  })
}

function getErrorStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null
  }

  const candidate = error as {
    status?: unknown
  }

  return typeof candidate.status === 'number' ? candidate.status : null
}

function buildDecisionMismatchReason(input: {
  actualDecision: ReviewDecision
  expectedDecision: ReviewDecision
}): string {
  return [
    'Codex returned a decision that does not match the findings severity policy.',
    `Expected "${input.expectedDecision}" but received "${input.actualDecision}".`,
  ].join(' ')
}

export class ReviewService {
  private readonly queue: QueueRequest[] = []
  private readonly queuedByPullRequestKey = new Map<string, QueueRequest>()
  private readonly approvedLockedPullRequests = new Set<string>()
  private readonly latestHeadByPullRequest = new Map<string, string>()

  private readonly approvedLockEnabled: boolean
  private readonly discussionCacheDirectory: string
  private readonly discussionCacheTtlMs: number

  private activeRun: ActiveRun | null = null
  private queueDrainInProgress = false

  constructor(
    private readonly github: ReviewPlatform,
    private readonly codex: CodexRunner,
    private readonly workspaceManager: ReviewWorkspaceManager,
    private readonly logger: AppLogger,
    private readonly botLogin: string,
    options: ReviewServiceOptions = {},
  ) {
    this.approvedLockEnabled = options.approvedLockEnabled ?? true
    this.discussionCacheDirectory =
      options.discussionCacheDirectory ?? defaultDiscussionCacheDirectory
    this.discussionCacheTtlMs =
      options.discussionCacheTtlMs ?? defaultDiscussionCacheTtlMs
  }

  async handlePullRequestEvent(
    event: NormalizedPullRequestEvent,
  ): Promise<void> {
    const deliveryLogger = this.createDeliveryLogger(event)
    const routedEvent = this.routePullRequestEvent(event)

    deliveryLogger.info(
      {
        beforeSha: event.beforeSha,
        botStillRequested: event.botStillRequested,
        event: 'webhook.routed',
        requestedReviewerLogins: event.requestedReviewerLogins,
        status: routedEvent.status,
        ...(routedEvent.status !== 'trigger_review'
          ? { reason: routedEvent.reason }
          : {}),
      },
      'Webhook routed',
    )

    if (routedEvent.status === 'ignored') {
      return
    }

    if (routedEvent.status === 'cancel_requested') {
      this.cancelQueuedAndActivePullRequest(event, deliveryLogger)
      return
    }

    await this.enqueueReview(event, deliveryLogger)
  }

  private createDeliveryLogger(event: NormalizedPullRequestEvent): AppLogger {
    return createChildLogger(this.logger, {
      action: event.action,
      component: 'review',
      deliveryId: event.deliveryId,
      eventName: event.eventName,
      headSha: event.headSha,
      owner: event.owner,
      pullNumber: event.pullNumber,
      repo: event.repo,
      requestedReviewerLogin: event.requestedReviewerLogin,
      senderLogin: event.senderLogin,
    })
  }

  private routePullRequestEvent(
    event: NormalizedPullRequestEvent,
  ): RoutedPullRequestEvent {
    if (event.actionKind === 'review_requested') {
      return event.requestedReviewerLogin === this.botLogin
        ? { status: 'trigger_review', reason: 'review_requested' }
        : { status: 'ignored', reason: 'reviewer_mismatch' }
    }

    if (event.actionKind === 'review_request_removed') {
      return event.requestedReviewerLogin === this.botLogin
        ? { status: 'cancel_requested', reason: 'cancel_requested' }
        : { status: 'ignored', reason: 'reviewer_mismatch' }
    }

    if (event.actionKind === 'synchronize') {
      return event.botStillRequested === true
        ? { status: 'trigger_review', reason: 'synchronize' }
        : { status: 'ignored', reason: 'bot_not_requested' }
    }

    return {
      status: 'ignored',
      reason: 'unsupported_action',
    }
  }

  private async enqueueReview(
    event: NormalizedPullRequestEvent,
    deliveryLogger: AppLogger,
  ): Promise<void> {
    const context = toPullRequestContext(event)
    const pullRequestKey = buildPullRequestKey(context)

    if (
      this.approvedLockEnabled &&
      this.approvedLockedPullRequests.has(pullRequestKey)
    ) {
      deliveryLogger.info(
        {
          event: 'review.queue_ignored',
          reason: 'approved_locked',
          status: 'ignored',
        },
        'Review queued event ignored',
      )
      return
    }

    const currentLatestSha = this.latestHeadByPullRequest.get(pullRequestKey)
    if (
      !currentLatestSha ||
      currentLatestSha === context.headSha ||
      this.isVerifiedLaterHead(currentLatestSha, event)
    ) {
      this.latestHeadByPullRequest.set(pullRequestKey, context.headSha)
    }

    const inFlightRun = this.activeRun
    if (
      inFlightRun &&
      inFlightRun.pullRequestKey === pullRequestKey &&
      inFlightRun.context.headSha === context.headSha
    ) {
      deliveryLogger.info(
        {
          event: 'review.queue_ignored',
          reason: 'duplicate_inflight',
          runKey: inFlightRun.runKey,
          status: 'ignored',
        },
        'Review queued event ignored',
      )
      return
    }

    const existingQueued = this.queuedByPullRequestKey.get(pullRequestKey)
    if (existingQueued?.event.headSha === context.headSha) {
      deliveryLogger.info(
        {
          event: 'review.queue_ignored',
          reason: 'duplicate_queued',
          status: 'ignored',
        },
        'Review queued event ignored',
      )
      return
    }

    if (existingQueued) {
      this.removeQueuedRequest(pullRequestKey)
    }

    const request: QueueRequest = {
      ...createCompletion(),
      enqueuedAt: Date.now(),
      event,
    }

    this.queue.push(request)
    this.queuedByPullRequestKey.set(pullRequestKey, request)

    if (
      inFlightRun &&
      inFlightRun.pullRequestKey === pullRequestKey &&
      inFlightRun.context.headSha !== context.headSha &&
      this.isVerifiedLaterHead(inFlightRun.context.headSha, event)
    ) {
      this.requestRunCancellation(
        inFlightRun,
        'superseded_by_new_commit',
        deliveryLogger,
      )
    }

    deliveryLogger.info(
      {
        event: 'review.enqueued',
        queueLength: this.queue.length,
        reason: 'trigger_review',
        routedReason: event.actionKind,
        status: 'queued',
      },
      'Review enqueued',
    )

    this.drainQueue()
    await request.completion
  }

  private cancelQueuedAndActivePullRequest(
    event: NormalizedPullRequestEvent,
    deliveryLogger: AppLogger,
  ): void {
    const context = toPullRequestContext(event)
    const pullRequestKey = buildPullRequestKey(context)
    const removedQueuedRequest = this.removeQueuedRequest(pullRequestKey)

    const inFlightRun = this.activeRun
    const canceledActiveRun =
      inFlightRun?.pullRequestKey === pullRequestKey
        ? this.requestRunCancellation(
            inFlightRun,
            'cancel_requested',
            deliveryLogger,
          )
        : false

    if (!removedQueuedRequest && !canceledActiveRun) {
      deliveryLogger.info(
        {
          event: 'review.cancel_missed',
          reason: 'cancel_requested',
          status: 'cancel_missed',
        },
        'Review cancel missed',
      )
      return
    }

    deliveryLogger.info(
      {
        canceledActiveRun,
        event: 'review.cancel_requested',
        queueLength: this.queue.length,
        removedQueuedRequest,
        status: 'cancel_requested',
      },
      'Review cancel requested',
    )
  }

  private removeQueuedRequest(pullRequestKey: string): boolean {
    const request = this.queuedByPullRequestKey.get(pullRequestKey)
    if (!request) {
      return false
    }

    this.queuedByPullRequestKey.delete(pullRequestKey)
    const requestIndex = this.queue.indexOf(request)
    if (requestIndex >= 0) {
      this.queue.splice(requestIndex, 1)
    }

    request.resolveCompletion()

    return true
  }

  /**
   * Returns true only when `event` is a `synchronize` whose `beforeSha` directly
   * chains from `currentSha`, meaning it is a verifiable forward progression in
   * the commit history.  Any other event type (including a delayed
   * `review_requested` for an older commit) returns false, preventing stale
   * out-of-order webhooks from overwriting a newer tracked SHA or cancelling
   * an in-flight review that is still current.
   */
  private isVerifiedLaterHead(
    currentSha: string,
    event: NormalizedPullRequestEvent,
  ): boolean {
    return event.actionKind === 'synchronize' && event.beforeSha === currentSha
  }

  private requestRunCancellation(
    run: ActiveRun,
    reason: QueueCancelReason,
    deliveryLogger: AppLogger,
  ): boolean {
    if (run.abortController.signal.aborted) {
      return false
    }

    run.cancellationReason = reason
    run.abortController.abort()
    deliveryLogger.info(
      {
        event: 'review.cancel_requested',
        reason,
        runKey: run.runKey,
        status: 'cancel_requested',
      },
      'Review cancel requested',
    )
    return true
  }

  private shouldStopForCancellation(
    runLogger: AppLogger,
    run: ActiveRun,
    stage: string,
  ): boolean {
    const latestHeadSha = this.latestHeadByPullRequest.get(run.pullRequestKey)

    if (
      latestHeadSha &&
      latestHeadSha !== run.context.headSha &&
      !run.abortController.signal.aborted
    ) {
      run.cancellationReason = 'superseded_by_new_commit'
      run.abortController.abort()
    }

    if (!run.abortController.signal.aborted) {
      return false
    }

    if (!run.cancellationLogged) {
      run.cancellationLogged = true
      runLogger.info(
        {
          event: 'review.canceled',
          reason: run.cancellationReason ?? 'cancel_requested',
          runKey: run.runKey,
          stage,
          status: 'canceled',
        },
        'Review canceled',
      )
    }

    return true
  }

  private drainQueue(): void {
    if (this.queueDrainInProgress) {
      return
    }

    this.queueDrainInProgress = true
    void this.runQueueDrain()
  }

  private async runQueueDrain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const queuedRequest = this.queue.shift()
        if (!queuedRequest) {
          continue
        }

        const context = toPullRequestContext(queuedRequest.event)
        const pullRequestKey = buildPullRequestKey(context)

        if (this.queuedByPullRequestKey.get(pullRequestKey) === queuedRequest) {
          this.queuedByPullRequestKey.delete(pullRequestKey)
        }

        if (
          this.approvedLockEnabled &&
          this.approvedLockedPullRequests.has(pullRequestKey)
        ) {
          const logger = this.createDeliveryLogger(queuedRequest.event)
          logger.info(
            {
              event: 'review.queue_ignored',
              reason: 'approved_locked',
              status: 'ignored',
            },
            'Review queued event ignored',
          )
          queuedRequest.resolveCompletion()
          continue
        }

        const latestHeadSha = this.latestHeadByPullRequest.get(pullRequestKey)
        if (latestHeadSha && latestHeadSha !== context.headSha) {
          const logger = this.createDeliveryLogger(queuedRequest.event)
          logger.info(
            {
              event: 'review.queue_ignored',
              latestHeadSha,
              queuedHeadSha: context.headSha,
              reason: 'superseded_queued_head',
              status: 'ignored',
            },
            'Review queued event ignored',
          )
          queuedRequest.resolveCompletion()
          continue
        }

        await this.reviewPullRequest(
          queuedRequest.event,
          this.createDeliveryLogger(queuedRequest.event),
        )
        queuedRequest.resolveCompletion()
      }
    } finally {
      this.queueDrainInProgress = false
      if (this.queue.length > 0) {
        this.drainQueue()
      }
    }
  }

  private async cleanupExpiredDiscussionSnapshots(
    runLogger: AppLogger,
  ): Promise<void> {
    const expirationThreshold = Date.now() - this.discussionCacheTtlMs

    const pullRequestDirectories = await readdir(
      this.discussionCacheDirectory,
      {
        encoding: 'utf8',
        withFileTypes: true,
      },
    ).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return null
      }

      runLogger.warn(
        {
          error,
          event: 'review.discussion_context_cleanup_failed',
          reason: 'list_directory_failed',
          status: 'failed',
        },
        'Review discussion context cleanup failed',
      )
      return null
    })

    if (!pullRequestDirectories) {
      return
    }

    for (const entry of pullRequestDirectories) {
      if (!entry.isDirectory()) {
        continue
      }

      const pullRequestDirectoryPath = path.join(
        this.discussionCacheDirectory,
        entry.name,
      )
      const files = await readdir(pullRequestDirectoryPath, {
        encoding: 'utf8',
        withFileTypes: true,
      }).catch(() => [])

      for (const file of files) {
        if (!file.isFile()) {
          continue
        }

        const filePath = path.join(pullRequestDirectoryPath, file.name)
        const fileStats = await stat(filePath).catch(() => null)
        if (!fileStats || fileStats.mtimeMs > expirationThreshold) {
          continue
        }

        await rm(filePath, { force: true }).catch(() => undefined)
      }

      const remainingFiles = await readdir(pullRequestDirectoryPath, {
        encoding: 'utf8',
        withFileTypes: true,
      }).catch(() => [])
      if (remainingFiles.length === 0) {
        await rm(pullRequestDirectoryPath, {
          force: true,
          recursive: true,
        }).catch(() => undefined)
      }
    }
  }

  private async persistDiscussionContext(input: {
    context: PullRequestContext
    discussionMarkdown: string
    runLogger: AppLogger
    workingDirectory: string
  }): Promise<void> {
    await mkdir(this.discussionCacheDirectory, { recursive: true })
    await this.cleanupExpiredDiscussionSnapshots(input.runLogger)
    await mkdir(input.workingDirectory, { recursive: true })

    const pullRequestDirectoryName = `${input.context.owner}__${input.context.repo}__pr-${input.context.pullNumber}`
    const pullRequestDirectoryPath = path.join(
      this.discussionCacheDirectory,
      pullRequestDirectoryName,
    )
    await mkdir(pullRequestDirectoryPath, { recursive: true })

    const cacheSnapshotPath = path.join(
      pullRequestDirectoryPath,
      `${input.context.headSha}.md`,
    )
    const workspaceDiscussionPath = path.join(
      input.workingDirectory,
      reviewCommentsFileName,
    )

    await writeFile(cacheSnapshotPath, input.discussionMarkdown, 'utf8')
    await writeFile(workspaceDiscussionPath, input.discussionMarkdown, 'utf8')

    input.runLogger.info(
      {
        cacheSnapshotPath,
        discussionFile: reviewCommentsFileName,
        event: 'review.discussion_context_saved',
        status: 'completed',
      },
      'Review discussion context saved',
    )
  }

  private async reviewPullRequest(
    event: NormalizedPullRequestEvent,
    deliveryLogger: AppLogger,
  ): Promise<void> {
    const context = toPullRequestContext(event)
    const pullRequestKey = buildPullRequestKey(context)
    const runKey = buildRunKey(context)
    const marker = buildReviewMarker(context.headSha)
    const startedAt = Date.now()
    const runLogger = createChildLogger(deliveryLogger, {
      runKey,
    })
    const run: ActiveRun = {
      abortController: new AbortController(),
      cancellationLogged: false,
      cancellationReason: null,
      context,
      pullRequestKey,
      runKey,
    }
    let publishedReview = false

    this.activeRun = run

    runLogger.info(
      {
        event: 'review.started',
        queueLength: this.queue.length,
        status: 'started',
      },
      'Review started',
    )

    try {
      let hasPublishedResult = false

      try {
        hasPublishedResult = await this.github.hasPublishedResult(
          context,
          marker,
        )
      } catch (error) {
        const status = getErrorStatusCode(error)

        if (status === 404) {
          runLogger.warn(
            {
              error,
              event: 'review.idempotency_checked',
              httpStatus: status,
              reason: 'marker_not_found',
              status: 'completed',
            },
            'Review idempotency marker missing',
          )
        } else {
          throw error
        }
      }

      runLogger.info(
        {
          event: 'review.idempotency_checked',
          hasPublishedResult,
          status: 'completed',
        },
        'Review idempotency checked',
      )

      if (hasPublishedResult) {
        runLogger.info(
          {
            event: 'review.completed',
            reason: 'already_published',
            status: 'ignored',
          },
          'Review completed',
        )
        return
      }

      if (this.shouldStopForCancellation(runLogger, run, 'after_idempotency')) {
        return
      }

      // Step 1: Fetch PR intelligence package before workspace setup
      const prInfo: PRInfoObject = await this.github.getPRInfo(context)

      runLogger.info(
        {
          commitCount: prInfo.commits.length,
          event: 'review.pr_info_fetched',
          fileCount: prInfo.changedFilePaths.length,
          status: 'completed',
        },
        'PR info fetched',
      )

      if (this.shouldStopForCancellation(runLogger, run, 'after_pr_info')) {
        return
      }

      const workspace = await this.workspaceManager.prepareWorkspace(
        context,
        prInfo,
        createChildLogger(runLogger, {
          component: 'workspace',
        }),
      )

      try {
        runLogger.info(
          {
            event: 'review.workspace_prepared',
            reviewableFileCount: workspace.reviewableFiles.length,
            status: 'completed',
            workingDirectory: workspace.workingDirectory,
          },
          'Review workspace prepared',
        )

        if (
          this.shouldStopForCancellation(
            runLogger,
            run,
            'after_workspace_prepare',
          )
        ) {
          return
        }

        if (workspace.reviewableFiles.length === 0) {
          runLogger.info(
            {
              event: 'review.completed',
              reason: 'no_reviewable_files',
              status: 'ignored',
            },
            'Review completed',
          )
          return
        }

        const discussionMarkdown =
          await this.github.getPullRequestDiscussionMarkdown(context)
        await this.persistDiscussionContext({
          context,
          discussionMarkdown,
          runLogger,
          workingDirectory: workspace.workingDirectory,
        })

        if (
          this.shouldStopForCancellation(
            runLogger,
            run,
            'after_discussion_context',
          )
        ) {
          return
        }

        const phase1Prompt = buildPhase1Prompt({
          owner: context.owner,
          repo: context.repo,
          pullNumber: context.pullNumber,
          title: context.title,
          headSha: context.headSha,
          prInfoFilePath: 'pr-info.yaml',
        })

        runLogger.info(
          {
            event: 'review.prompts_built',
            phase1PromptChars: phase1Prompt.length,
            reviewableFileCount: workspace.reviewableFiles.length,
            status: 'completed',
          },
          'Review prompts built',
        )

        const outcome = await this.codex.reviewChained(
          {
            abortSignal: run.abortController.signal,
            phase1Prompt,
            phase2Prompt: (phase1Out) =>
              buildPhase2Prompt({
                phase1Summary: phase1Out,
              }),
            phase3Prompt: (phase2Out) =>
              buildPhase3Prompt({
                owner: context.owner,
                repo: context.repo,
                pullNumber: context.pullNumber,
                title: context.title,
                headSha: context.headSha,
                changesOverview: phase2Out,
                discussionFilePath: reviewCommentsFileName,
              }),
            workingDirectory: workspace.workingDirectory,
          },
          createChildLogger(runLogger, {
            component: 'codex',
          }),
        )

        if (!outcome.ok) {
          if (
            outcome.cancelled ||
            this.shouldStopForCancellation(runLogger, run, 'after_codex')
          ) {
            return
          }

          runLogger.warn(
            {
              event: 'review.codex_failed',
              reason: outcome.reason,
              status: 'failed',
            },
            'Review Codex step failed',
          )

          await this.github.publishFailureComment(
            context,
            buildFailureComment({
              headSha: context.headSha,
              reason: outcome.reason,
            }),
          )
          return
        }

        runLogger.info(
          {
            decision: outcome.result.decision,
            event: 'review.codex_completed',
            findingCount: outcome.result.findings.length,
            score: outcome.result.score,
            status: 'completed',
          },
          'Review Codex step completed',
        )

        if (this.shouldStopForCancellation(runLogger, run, 'after_codex')) {
          return
        }

        const expectedDecision = determineReviewDecision(
          outcome.result.findings,
        )
        if (outcome.result.decision !== expectedDecision) {
          const reason = buildDecisionMismatchReason({
            actualDecision: outcome.result.decision,
            expectedDecision,
          })

          runLogger.warn(
            {
              actualDecision: outcome.result.decision,
              event: 'review.codex_contract_mismatch',
              expectedDecision,
              status: 'failed',
            },
            'Review Codex contract mismatch',
          )

          await this.github.publishFailureComment(
            context,
            buildFailureComment({
              headSha: context.headSha,
              reason,
            }),
          )
          return
        }

        const reviewEvent = toReviewEvent(outcome.result.decision)
        const { comments, overflowFindings } =
          separateInlineAndOverflowFindings(
            outcome.result.findings,
            workspace.reviewableFiles,
          )

        runLogger.info(
          {
            event: 'review.publish_started',
            inlineCommentCount: comments.length,
            overflowFindingCount: overflowFindings.length,
            reviewEvent,
            status: 'started',
          },
          'Review publish started',
        )

        if (this.shouldStopForCancellation(runLogger, run, 'before_publish')) {
          return
        }

        const body = buildReviewBody({
          headSha: context.headSha,
          score: outcome.result.score,
          summary: outcome.result.summary,
          ...(outcome.result.changesOverview
            ? { changesOverview: outcome.result.changesOverview }
            : {}),
          event: reviewEvent,
          overflowFindings,
        })
        const fallbackBody = buildReviewBody({
          headSha: context.headSha,
          score: outcome.result.score,
          summary: outcome.result.summary,
          ...(outcome.result.changesOverview
            ? { changesOverview: outcome.result.changesOverview }
            : {}),
          event: reviewEvent,
          overflowFindings: outcome.result.findings,
        })

        try {
          await this.github.publishReview({
            context,
            body,
            event: reviewEvent,
            comments,
          })
          publishedReview = true
          runLogger.info(
            {
              event: 'review.published',
              inlineCommentCount: comments.length,
              reviewEvent,
              status: 'published',
            },
            'Review published',
          )
        } catch (error) {
          if (!comments.length || !isInvalidInlineReviewCommentError(error)) {
            throw error
          }

          runLogger.warn(
            {
              commentCount: comments.length,
              error,
              event: 'review.publish_fallback',
              reason: 'invalid_inline_location',
              status: 'retrying',
            },
            'Review publish fallback',
          )

          if (
            this.shouldStopForCancellation(
              runLogger,
              run,
              'before_publish_fallback',
            )
          ) {
            return
          }

          await this.github.publishReview({
            context,
            body: fallbackBody,
            event: reviewEvent,
            comments: [],
          })
          publishedReview = true
          runLogger.info(
            {
              event: 'review.publish_fallback',
              fallbackMode: true,
              reviewEvent,
              status: 'published',
            },
            'Review published',
          )
        }

        if (reviewEvent === 'APPROVE' && this.approvedLockEnabled) {
          this.approvedLockedPullRequests.add(pullRequestKey)
          this.removeQueuedRequest(pullRequestKey)
          runLogger.info(
            {
              event: 'review.approved_locked',
              status: 'completed',
            },
            'Review approved lock applied',
          )
        }
      } finally {
        await workspace.cleanup()
      }
    } catch (error) {
      if (this.shouldStopForCancellation(runLogger, run, 'on_error')) {
        return
      }

      runLogger.error(
        {
          error,
          event: 'review.failed',
          status: 'failed',
        },
        'Review failed',
      )

      try {
        await this.github.publishFailureComment(
          context,
          buildFailureComment({
            headSha: context.headSha,
            reason:
              'The review pipeline failed before it could submit a review.',
          }),
        )
      } catch (failureCommentError) {
        runLogger.error(
          {
            event: 'review.failed',
            failureCommentError,
            originalError: error,
            reason: 'failure_comment_failed',
            status: 'failed',
          },
          'Review failure comment publish failed',
        )
      }
    } finally {
      if (this.activeRun?.runKey === runKey) {
        this.activeRun = null
      }

      if (publishedReview && run.abortController.signal.aborted) {
        runLogger.info(
          {
            event: 'review.cancel_missed',
            reason: run.cancellationReason ?? 'cancel_requested',
            status: 'cancel_missed',
          },
          'Review cancel missed',
        )
      }

      runLogger.info(
        {
          durationMs: Date.now() - startedAt,
          event: 'review.completed',
          status: 'completed',
        },
        'Review completed',
      )
    }
  }
}
