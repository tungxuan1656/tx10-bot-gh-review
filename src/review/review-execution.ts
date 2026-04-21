import { determineReviewDecision } from './decision.js'
import {
  buildInitialReviewPhase2Prompt,
  buildPhase1Prompt,
  buildReReviewPrompt,
} from './prompt.js'
import {
  buildFailureComment,
  buildReviewMarker,
} from './summary.js'
import { createChildLogger } from '../logger.js'
import type { AppLogger } from '../logger.js'
import type { CodexRunner } from './codex.js'
import type { ReviewPlatform } from './github-platform.js'
import type { NormalizedPullRequestEvent } from './webhook-event.js'
import type { ReviewWorkspaceManager } from './workspace.js'
import type { DiscussionCacheOptions } from './discussion-cache.js'
import { persistDiscussionContext, reviewCommentsFileName } from './discussion-cache.js'
import {
  buildDecisionMismatchReason,
  buildPullRequestKey,
  buildRunKey,
  getErrorStatusCode,
  resolveReReviewDelta,
  toPullRequestContext,
  toReviewMode,
} from './service-helpers.js'
import type { ActiveRun, ActiveRunRef, ReviewQueueManager } from './review-queue.js'
import { publishSuccessfulReview, setPullRequestReaction } from './review-publishing.js'

const previousReviewedRefName = 'refs/codex-review/previous'

type ReviewExecutionInput = {
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

export async function reviewPullRequest(input: ReviewExecutionInput): Promise<void> {
  const context = toPullRequestContext(input.event)
  const pullRequestKey = buildPullRequestKey(context)
  const runKey = buildRunKey(context)
  const marker = buildReviewMarker(context.headSha, input.event.deliveryId)
  const startedAt = Date.now()
  const runLogger = createChildLogger(input.deliveryLogger, {
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

  input.activeRunRef.current = run

  runLogger.info(
    {
      event: 'review.started',
      queueLength: input.queueManager.queueLength,
      status: 'started',
    },
    'Review started',
  )

  try {
    let hasPublishedResult = false

    try {
      hasPublishedResult = await input.github.hasPublishedResult(
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

    if (
      input.queueManager.shouldStopForCancellation(
        runLogger,
        run,
        'after_idempotency',
      )
    ) {
      return
    }

    const priorSuccessfulReview = await input.github.getPriorSuccessfulReview(
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

    const prInfo = await input.github.getPRInfo(context)

    runLogger.info(
      {
        commitCount: prInfo.commits.length,
        event: 'review.pr_info_fetched',
        fileCount: prInfo.changedFilePaths.length,
        status: 'completed',
      },
      'PR info fetched',
    )

    if (
      input.queueManager.shouldStopForCancellation(
        runLogger,
        run,
        'after_pr_info',
      )
    ) {
      return
    }

    const additionalRevisions =
      reviewMode === 're_review' &&
      priorSuccessfulReview.latestReviewedSha &&
      priorSuccessfulReview.latestReviewedSha !== context.headSha
        ? [
            {
              revision: priorSuccessfulReview.latestReviewedSha,
              fallbackRef: context.headRef,
              localRef: previousReviewedRefName,
              remote: 'head' as const,
            },
          ]
        : []

    const workspace = await input.workspaceManager.prepareWorkspace(
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
        input.queueManager.shouldStopForCancellation(
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

        await setPullRequestReaction({
          context,
          deliveryLogger: runLogger,
          github: input.github,
          reaction: 'laugh',
          reason: 'no_reviewable_files',
        })
        return
      }

      await setPullRequestReaction({
        context,
        deliveryLogger: runLogger,
        github: input.github,
        reaction: 'eyes',
        reason: 'review_started',
      })

      const discussionMarkdown =
        await input.github.getPullRequestDiscussionMarkdown(context)
      await persistDiscussionContext({
        context,
        discussionMarkdown,
        runLogger,
        workingDirectory: workspace.workingDirectory,
        options: input.discussionCacheOptions,
      })

      if (
        input.queueManager.shouldStopForCancellation(
          runLogger,
          run,
          'after_discussion_context',
        )
      ) {
        return
      }

      const reviewablePaths = workspace.reviewableFiles.map((file) => file.path)

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

              return input.codex.reviewTwoPhase(
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

              return input.codex.review(
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
          input.queueManager.shouldStopForCancellation(
            runLogger,
            run,
            'after_codex',
          )
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

        await input.github.publishFailureComment(
          context,
          buildFailureComment({
            headSha: context.headSha,
            runToken: input.event.deliveryId,
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

      if (
        input.queueManager.shouldStopForCancellation(
          runLogger,
          run,
          'after_codex',
        )
      ) {
        return
      }

      const expectedDecision = determineReviewDecision(outcome.result.findings)
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

        await input.github.publishFailureComment(
          context,
          buildFailureComment({
            headSha: context.headSha,
            runToken: input.event.deliveryId,
            reason,
          }),
        )
        return
      }

      publishedReview = await publishSuccessfulReview({
        approvedLockEnabled: input.approvedLockEnabled,
        approvedLockedPullRequests: input.approvedLockedPullRequests,
        context,
        deliveryId: input.event.deliveryId,
        github: input.github,
        outcome,
        queueManager: input.queueManager,
        run,
        runLogger,
        reviewableFiles: workspace.reviewableFiles,
      })

    } finally {
      await workspace.cleanup()
    }
  } catch (error) {
    if (input.queueManager.shouldStopForCancellation(runLogger, run, 'on_error')) {
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
      await input.github.publishFailureComment(
        context,
        buildFailureComment({
          headSha: context.headSha,
          runToken: input.event.deliveryId,
          reason: 'The review pipeline failed before it could submit a review.',
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
    if (input.activeRunRef.current?.runKey === runKey) {
      input.activeRunRef.current = null
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
