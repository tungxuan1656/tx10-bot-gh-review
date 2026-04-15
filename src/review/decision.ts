import type {
  FindingSeverity,
  ReviewDecision,
  ReviewEvent,
  ReviewFinding,
} from './types.js'

const severityRank: Record<FindingSeverity, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  improvement: 1,
}

export function determineReviewDecision(
  findings: ReviewFinding[],
): ReviewDecision {
  return findings.some(
    (finding) =>
      finding.severity === 'critical' || finding.severity === 'major',
  )
    ? 'request_changes'
    : 'approve'
}

export function toReviewEvent(decision: ReviewDecision): ReviewEvent {
  return decision === 'request_changes' ? 'REQUEST_CHANGES' : 'APPROVE'
}

export function sortFindingsBySeverity(
  findings: ReviewFinding[],
): ReviewFinding[] {
  return [...findings].sort((left, right) => {
    return severityRank[right.severity] - severityRank[left.severity]
  })
}
