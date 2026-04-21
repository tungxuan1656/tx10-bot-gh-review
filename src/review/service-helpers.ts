import { isCommentableRightSideLine } from './patch.js'
import type {
  InlineReviewComment,
  NormalizedPullRequestEvent,
  PullRequestContext,
  ReReviewDelta,
  ReviewMode,
  ReviewDecision,
  ReviewFinding,
  ReviewableFile,
  PriorSuccessfulReviewInfo,
  RoutedPullRequestEvent,
} from './types.js'

export function normalizeOptionalText(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function toPullRequestContext(
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

export function buildRunKey(context: PullRequestContext): string {
  return `${context.owner}/${context.repo}#${context.pullNumber}@${context.headSha}`
}

export function buildPullRequestKey(context: PullRequestContext): string {
  return `${context.owner}/${context.repo}#${context.pullNumber}`
}

function toInlineComment(finding: ReviewFinding): string {
  return [
    `**${finding.severity.toUpperCase()}**: ${finding.title}`,
    '',
    finding.comment,
  ].join('\n')
}

export function separateInlineAndOverflowFindings(
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

export function isInvalidInlineReviewCommentError(error: unknown): boolean {
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
      message.includes('review comments is invalid') ||
      message.includes('review threads is invalid')
    )
  })
}

export function getErrorStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null
  }

  const candidate = error as { status?: unknown }
  return typeof candidate.status === 'number' ? candidate.status : null
}

export function buildDecisionMismatchReason(input: {
  actualDecision: ReviewDecision
  expectedDecision: ReviewDecision
}): string {
  return [
    'Codex returned a decision that does not match the findings severity policy.',
    `Expected "${input.expectedDecision}" but received "${input.actualDecision}".`,
  ].join(' ')
}

export function toReviewMode(input: PriorSuccessfulReviewInfo): ReviewMode {
  return input.hasPriorSuccessfulReview ? 're_review' : 'initial_review'
}

export function resolveReReviewDelta(input: {
  latestReviewedSha: string | null
  currentHeadSha: string
  availableRevisionRefs: string[]
}): ReReviewDelta {
  if (!input.latestReviewedSha) {
    return {
      deltaFromRef: 'refs/codex-review/base',
      deltaToRef: 'refs/codex-review/head',
      fallbackReason: 'latest_review_sha_unavailable',
    }
  }

  if (
    input.availableRevisionRefs.includes('refs/codex-review/previous') &&
    input.latestReviewedSha !== input.currentHeadSha
  ) {
    return {
      deltaFromRef: 'refs/codex-review/previous',
      deltaToRef: 'refs/codex-review/head',
      fallbackReason: null,
    }
  }

  if (input.availableRevisionRefs.includes('refs/codex-review/base')) {
    return {
      deltaFromRef: 'refs/codex-review/base',
      deltaToRef: 'refs/codex-review/head',
      fallbackReason: 'previous_review_sha_not_fetchable',
    }
  }

  return {
    deltaFromRef: 'refs/codex-review/head',
    deltaToRef: 'refs/codex-review/head',
    fallbackReason: 'previous_review_sha_not_fetchable',
  }
}

export function routePullRequestEvent(input: {
  actionKind: NormalizedPullRequestEvent['actionKind']
  botLogin: string
  requestedReviewerLogin: string | null
}): RoutedPullRequestEvent {
  if (input.actionKind === 'review_requested') {
    return input.requestedReviewerLogin === input.botLogin
      ? { status: 'trigger_review', reason: 'review_requested' }
      : { status: 'ignored', reason: 'reviewer_mismatch' }
  }

  if (input.actionKind === 'review_request_removed') {
    return input.requestedReviewerLogin === input.botLogin
      ? { status: 'cancel_requested', reason: 'cancel_requested' }
      : { status: 'ignored', reason: 'reviewer_mismatch' }
  }

  if (input.actionKind === 'synchronize') {
    return { status: 'ignored', reason: 'synchronize_ignored' }
  }

  return {
    status: 'ignored',
    reason: 'unsupported_action',
  }
}
