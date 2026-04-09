import type { FindingSeverity, ReviewEvent, ReviewFinding } from "./types.js";

const severityRank: Record<FindingSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export function determineReviewEvent(findings: ReviewFinding[]): ReviewEvent {
  if (findings.some((finding) => finding.severity === "critical" || finding.severity === "high")) {
    return "REQUEST_CHANGES";
  }

  if (findings.length > 0) {
    return "COMMENT";
  }

  return "APPROVE";
}

export function sortFindingsBySeverity(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((left, right) => {
    return severityRank[right.severity] - severityRank[left.severity];
  });
}
