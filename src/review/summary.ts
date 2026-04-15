import { sortFindingsBySeverity } from "./decision.js";
import type { ReviewEvent, ReviewFinding } from "./types.js";

export function buildReviewMarker(headSha: string): string {
  return `<!-- ai-review-bot:sha=${headSha} -->`;
}

function renderFinding(finding: ReviewFinding): string {
  return `- **${finding.severity.toUpperCase()}** \`${finding.path}:${finding.line}\` ${finding.title}: ${finding.comment}`;
}

export function buildReviewBody(input: {
  headSha: string;
  score: number;
  summary: string;
  changesOverview?: string;
  event: ReviewEvent;
  overflowFindings: ReviewFinding[];
}): string {
  const statusLine =
    input.event === "REQUEST_CHANGES" ? "Verdict: REQUEST_CHANGES" : "Verdict: APPROVE";

  const changesOverviewSection =
    input.changesOverview && input.changesOverview.trim()
      ? ["", "### Changes Overview", input.changesOverview.trim()].join("\n")
      : "";

  const overflowSection =
    input.overflowFindings.length === 0
      ? ""
      : [
          "",
          "### Additional findings",
          ...sortFindingsBySeverity(input.overflowFindings).map(renderFinding),
        ].join("\n");

  return [
    buildReviewMarker(input.headSha),
    "## Codex Review",
    "",
    `${statusLine}`,
    `Code Quality Score: ${input.score.toFixed(1)}/10`,
    "",
    input.summary,
    changesOverviewSection,
    overflowSection,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildFailureComment(input: { headSha: string; reason: string }): string {
  return [
    buildReviewMarker(input.headSha),
    "## Codex Review",
    "",
    "The bot could not complete an AI review for this revision.",
    input.reason,
    "",
    "Push a new commit or re-request review to try again.",
  ].join("\n");
}
