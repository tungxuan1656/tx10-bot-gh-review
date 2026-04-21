import { describe, expect, it } from 'vitest'

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
} from '../src/review/service-helpers.js'
import type { NormalizedPullRequestEvent } from '../src/review/webhook-event.js'
import type {
  PriorSuccessfulReviewInfo,
  ReviewFinding,
  ReviewableFile,
} from '../src/review/types.js'

function createPullRequestEvent(
  overrides: Partial<NormalizedPullRequestEvent> = {},
): NormalizedPullRequestEvent {
  return {
    action: 'review_requested',
    actionKind: 'review_requested',
    afterSha: null,
    baseSha: 'def456',
    beforeSha: null,
    botStillRequested: null,
    deliveryId: 'delivery-123',
    eventName: 'pull_request',
    headSha: 'abc123',
    htmlUrl: 'https://github.com/acme/repo/pull/42',
    owner: 'acme',
    pullNumber: 42,
    repo: 'repo',
    requestedReviewerLogin: 'review-bot',
    requestedReviewerLogins: ['review-bot'],
    senderLogin: 'octocat',
    title: 'Add a review flow',
    headRef: 'feature/review-flow',
    headCloneUrl: 'https://github.com/acme/repo.git',
    baseRef: 'main',
    baseCloneUrl: 'https://github.com/acme/repo.git',
    ...overrides,
  }
}

describe('review service helpers', () => {
  it('normalizes optional text', () => {
    expect(normalizeOptionalText('  hello  ')).toBe('hello')
    expect(normalizeOptionalText('   ')).toBeUndefined()
  })

  it('builds pull request context and keys', () => {
    const context = toPullRequestContext(createPullRequestEvent())

    expect(context.owner).toBe('acme')
    expect(buildPullRequestKey(context)).toBe('acme/repo#42')
    expect(buildRunKey(context)).toBe('acme/repo#42@abc123')
  })

  it('separates inline and overflow findings', () => {
    const files: ReviewableFile[] = [
      {
        path: 'src/app.ts',
        patch: '@@ -1 +1 @@\n-console.log("a")\n+console.log("b")',
        content: '',
      },
    ]
    const findings: ReviewFinding[] = [
      {
        severity: 'major',
        path: 'src/app.ts',
        line: 1,
        title: 'Inline issue',
        comment: 'Fix this line.',
      },
      {
        severity: 'minor',
        path: 'src/app.ts',
        line: 99,
        title: 'Overflow issue',
        comment: 'This is outside the patch.',
      },
    ]

    const result = separateInlineAndOverflowFindings(findings, files)

    expect(result.comments).toHaveLength(1)
    const comment = result.comments[0]!
    expect(comment).toMatchObject({
      path: 'src/app.ts',
      line: 1,
      side: 'RIGHT',
    })
    expect(comment.body).toContain('**MAJOR**: Inline issue')
    expect(result.overflowFindings).toHaveLength(1)
    expect(result.overflowFindings[0]).toMatchObject({
      title: 'Overflow issue',
    })
  })

  it('detects invalid inline review comment errors', () => {
    expect(
      isInvalidInlineReviewCommentError({
        status: 422,
        message: 'review comments is invalid',
      }),
    ).toBe(true)

    expect(
      isInvalidInlineReviewCommentError({
        status: 422,
        errors: [{ resource: 'PullRequestReviewComment', message: 'bad line' }],
      }),
    ).toBe(true)

    expect(isInvalidInlineReviewCommentError({ status: 500 })).toBe(false)
  })

  it('reads error status codes', () => {
    expect(getErrorStatusCode({ status: 404 })).toBe(404)
    expect(getErrorStatusCode({})).toBeNull()
  })

  it('builds decision mismatch reasons', () => {
    expect(
      buildDecisionMismatchReason({
        actualDecision: 'request_changes',
        expectedDecision: 'approve',
      }),
    ).toContain('Expected "approve" but received "request_changes".')
  })

  it('maps review mode from prior review state', () => {
    const prior: PriorSuccessfulReviewInfo = {
      hasPriorSuccessfulReview: false,
      latestReviewedSha: null,
      latestReviewState: null,
    }

    expect(toReviewMode(prior)).toBe('initial_review')
    expect(
      toReviewMode({
        ...prior,
        hasPriorSuccessfulReview: true,
      }),
    ).toBe('re_review')
  })

  it('resolves re-review deltas across fetch states', () => {
    expect(
      resolveReReviewDelta({
        latestReviewedSha: null,
        currentHeadSha: 'abc123',
        availableRevisionRefs: [],
      }),
    ).toEqual({
      deltaFromRef: 'refs/codex-review/base',
      deltaToRef: 'refs/codex-review/head',
      fallbackReason: 'latest_review_sha_unavailable',
    })

    expect(
      resolveReReviewDelta({
        latestReviewedSha: 'oldsha',
        currentHeadSha: 'abc123',
        availableRevisionRefs: [
          'refs/codex-review/base',
          'refs/codex-review/head',
          'refs/codex-review/previous',
        ],
      }),
    ).toEqual({
      deltaFromRef: 'refs/codex-review/previous',
      deltaToRef: 'refs/codex-review/head',
      fallbackReason: null,
    })
  })

  it('routes pull request events deterministically', () => {
    expect(
      routePullRequestEvent({
        actionKind: 'review_requested',
        botLogin: 'review-bot',
        requestedReviewerLogin: 'review-bot',
      }),
    ).toEqual({ status: 'trigger_review', reason: 'review_requested' })

    expect(
      routePullRequestEvent({
        actionKind: 'review_request_removed',
        botLogin: 'review-bot',
        requestedReviewerLogin: 'review-bot',
      }),
    ).toEqual({ status: 'cancel_requested', reason: 'cancel_requested' })

    expect(
      routePullRequestEvent({
        actionKind: 'synchronize',
        botLogin: 'review-bot',
        requestedReviewerLogin: 'review-bot',
      }),
    ).toEqual({ status: 'ignored', reason: 'synchronize_ignored' })
  })
})
