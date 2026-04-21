import { determineReviewDecision, toReviewEvent } from './decision.js'
import {
  buildInitialReviewPhase2Prompt,
  buildPhase1Prompt,
  buildReReviewPrompt,
} from './prompt.js'
import {
  buildFailureComment,
  buildReviewBody,
  buildReviewMarker,
} from './summary.js'
import { createChildLogger } from '../logger.js'
import type { AppLogger } from '../logger.js'
import type { CodexRunner } from './codex.js'
import type { ReviewPlatform, ReviewReaction } from './github-platform.js'
import type { NormalizedPullRequestEvent } from './webhook-event.js'
import type { PRInfoObject, PullRequestContext } from './types.js'
import type {
  AdditionalWorkspaceRevision,
  ReviewWorkspaceManager,
} from './workspace.js'
import {
  persistDiscussionContext,
  reviewCommentsFileName,
} from './discussion-cache.js'
import {
  buildDecisionMismatchReason,
  buildPullRequestKey,
  buildRunKey,
  getErrorStatusCode,
  isInvalidInlineReviewCommentError,
  normalizeOptionalText,
  resolveReReviewDelta,
  routePullRequestEvent,
  separateInlineAndOverflowFindings,
  toPullRequestContext,
  toReviewMode,
} from './service-helpers.js'

type QueueCancelReason = 'cancel_requested'

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

const approvedIgnoredReason = 'approved_before'
const previousReviewedRefName = 'refs/codex-review/previous'

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

export class ReviewService {
  private readonly queue: QueueRequest[] = []
  private readonly queuedByPullRequestKey = new Map<string, QueueRequest>()
  private readonly approvedLockedPullRequests = new Set<string>()

  private readonly approvedLockEnabled: boolean
  private readonly discussionCacheOptions: ReviewServiceOptions

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
    this.discussionCacheOptions = options
  }

  async handlePullRequestEvent(
    event: NormalizedPullRequestEvent,
  ): Promise<void> {
    const deliveryLogger = this.createDeliveryLogger(event)
    const context = toPullRequestContext(event)
    const pullRequestKey = buildPullRequestKey(context)
    const routedEventByAction = routePullRequestEvent({
      actionKind: event.actionKind,
      botLogin: this.botLogin,
      requestedReviewerLogin: event.requestedReviewerLogin,
    })
    const routedEvent =
      routedEventByAction.status === 'trigger_review' &&
      (await this.isApprovedLocked(context, pullRequestKey, deliveryLogger))
        ? ({
            status: 'ignored',
            reason: approvedIgnoredReason,
          } as const)
        : routedEventByAction

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
      if (
        routedEvent.reason !== approvedIgnoredReason &&
        !this.hasPendingReviewForPullRequest(pullRequestKey)
      ) {
        await this.setPullRequestReaction(
          context,
          'laugh',
          deliveryLogger,
          'ignored_event',
        )
      }

      return
    }

    if (routedEvent.status === 'cancel_requested') {
      this.cancelQueuedAndActivePullRequest(event, deliveryLogger)
      return
    }

    await this.enqueueReview(event, deliveryLogger)
  }

  private async isApprovedLocked(
    context: PullRequestContext,
    pullRequestKey: string,
    deliveryLogger: AppLogger,
  ): Promise<boolean> {
    if (!this.approvedLockEnabled) {
      return false
    }

    if (this.approvedLockedPullRequests.has(pullRequestKey)) {
      return true
    }

    try {
      const priorSuccessfulReview = await this.github.getPriorSuccessfulReview(
        context,
      )

      if (priorSuccessfulReview.latestReviewState !== 'APPROVED') {
        return false
      }

      this.approvedLockedPullRequests.add(pullRequestKey)
      return true
    } catch (error) {
      deliveryLogger.warn(
        {
          error,
          event: 'review.approved_lock_lookup_failed',
          status: 'failed',
        },
        'Approved lock lookup failed',
      )
      return false
    }
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

  private async enqueueReview(
    event: NormalizedPullRequestEvent,
    deliveryLogger: AppLogger,
  ): Promise<void> {
    const context = toPullRequestContext(event)
    const pullRequestKey = buildPullRequestKey(context)

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

  private hasPendingReviewForPullRequest(pullRequestKey: string): boolean {
    return (
      this.activeRun?.pullRequestKey === pullRequestKey ||
      this.queuedByPullRequestKey.has(pullRequestKey)
    )
  }

  private async setPullRequestReaction(
    context: PullRequestContext,
    reaction: ReviewReaction,
    deliveryLogger: AppLogger,
    reason: string,
  ): Promise<void> {
    try {
      await this.github.setPullRequestReaction(context, reaction)
      deliveryLogger.info(
        {
          event: 'review.reaction_updated',
          reaction,
          reason,
          status: 'completed',
        },
        'Review reaction updated',
      )
    } catch (error) {
      deliveryLogger.warn(
        {
          error,
          event: 'review.reaction_failed',
          reaction,
          reason,
          status: 'failed',
        },
        'Review reaction update failed',
      )
    }
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

  private async reviewPullRequest(
    event: NormalizedPullRequestEvent,
    deliveryLogger: AppLogger,
  ): Promise<void> {
    const context = toPullRequestContext(event)
    const pullRequestKey = buildPullRequestKey(context)
    const runKey = buildRunKey(context)
    const marker = buildReviewMarker(context.headSha, event.deliveryId)
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

      const priorSuccessfulReview = await this.github.getPriorSuccessfulReview(
        context,
      )
      const reviewMode = toReviewMode(priorSuccessfulReview)

      runLogger.info(
        {
          event: 'review.mode_selected',
          hasPriorSuccessfulReview:
            priorSuccessfulReview.hasPriorSuccessfulReview,
          latestReviewedSha: priorSuccessfulReview.latestReviewedSha,
          latestReviewState: priorSuccessfulReview.latestReviewState,
          reviewMode,
          status: 'completed',
        },
        'Review mode selected',
      )

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

      const additionalRevisions: AdditionalWorkspaceRevision[] =
        reviewMode === 're_review' &&
        priorSuccessfulReview.latestReviewedSha &&
        priorSuccessfulReview.latestReviewedSha !== context.headSha
          ? [
              {
                revision: priorSuccessfulReview.latestReviewedSha,
                fallbackRef: context.headRef,
                localRef: previousReviewedRefName,
                remote: 'head',
              },
            ]
          : []

      const workspace = await this.workspaceManager.prepareWorkspace(
        context,
        prInfo,
        createChildLogger(runLogger, {
          component: 'workspace',
        }),
        {
          additionalRevisions,
        },
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

          await this.setPullRequestReaction(
            context,
            'laugh',
            runLogger,
            'no_reviewable_files',
          )
          return
        }

        await this.setPullRequestReaction(
          context,
          'eyes',
          runLogger,
          'review_started',
        )

        const discussionMarkdown =
          await this.github.getPullRequestDiscussionMarkdown(context)
        await persistDiscussionContext({
          context,
          discussionMarkdown,
          runLogger,
          workingDirectory: workspace.workingDirectory,
          options: this.discussionCacheOptions,
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

        const reviewablePaths = workspace.reviewableFiles.map(
          (file) => file.path,
        )

        const outcome =
          reviewMode === 'initial_review'
            ? await (() => {
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
                    reviewMode,
                    reviewableFileCount: workspace.reviewableFiles.length,
                    status: 'completed',
                  },
                  'Review prompts built',
                )

                return this.codex.reviewTwoPhase(
                  {
                    abortSignal: run.abortController.signal,
                    phase1Prompt,
                    phase2Prompt: (phase1Summary) =>
                      buildInitialReviewPhase2Prompt({
                        owner: context.owner,
                        repo: context.repo,
                        pullNumber: context.pullNumber,
                        title: context.title,
                        headSha: context.headSha,
                        phase1Summary,
                        discussionFilePath: reviewCommentsFileName,
                        reviewablePaths,
                      }),
                    workingDirectory: workspace.workingDirectory,
                  },
                  createChildLogger(runLogger, {
                    component: 'codex',
                  }),
                )
              })()
            : await (() => {
                const delta = resolveReReviewDelta({
                  latestReviewedSha: priorSuccessfulReview.latestReviewedSha,
                  currentHeadSha: context.headSha,
                  availableRevisionRefs: workspace.availableRevisionRefs,
                })

                const prompt = buildReReviewPrompt({
                  owner: context.owner,
                  repo: context.repo,
                  pullNumber: context.pullNumber,
                  title: context.title,
                  headSha: context.headSha,
                  discussionFilePath: reviewCommentsFileName,
                  reviewablePaths,
                  deltaFromRef: delta.deltaFromRef,
                  deltaToRef: delta.deltaToRef,
                  deltaFromSha: priorSuccessfulReview.latestReviewedSha,
                  fallbackReason: delta.fallbackReason,
                })

                runLogger.info(
                  {
                    deltaFromRef: delta.deltaFromRef,
                    deltaToRef: delta.deltaToRef,
                    event: 'review.prompts_built',
                    fallbackReason: delta.fallbackReason,
                    promptChars: prompt.length,
                    reviewMode,
                    reviewableFileCount: workspace.reviewableFiles.length,
                    status: 'completed',
                  },
                  'Review prompts built',
                )

                return this.codex.review(
                  {
                    abortSignal: run.abortController.signal,
                    prompt,
                    workingDirectory: workspace.workingDirectory,
                  },
                  createChildLogger(runLogger, {
                    component: 'codex',
                  }),
                )
              })()

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
              runToken: event.deliveryId,
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
              runToken: event.deliveryId,
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

        const normalizedChangesOverview = normalizeOptionalText(
          outcome.result.changesOverview,
        )

        const body = buildReviewBody({
          headSha: context.headSha,
          runToken: event.deliveryId,
          score: outcome.result.score,
          summary: outcome.result.summary,
          ...(normalizedChangesOverview
            ? { changesOverview: normalizedChangesOverview }
            : {}),
          event: reviewEvent,
          overflowFindings,
        })
        const fallbackBody = buildReviewBody({
          headSha: context.headSha,
          runToken: event.deliveryId,
          score: outcome.result.score,
          summary: outcome.result.summary,
          ...(normalizedChangesOverview
            ? { changesOverview: normalizedChangesOverview }
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

        await this.setPullRequestReaction(
          context,
          reviewEvent === 'APPROVE' ? 'hooray' : 'confused',
          runLogger,
          'review_published',
        )

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
            runToken: event.deliveryId,
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
