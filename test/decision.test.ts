import { describe, expect, it } from "vitest";

import {
  determineReviewDecision,
  sortFindingsBySeverity,
  toReviewEvent,
} from "../src/review/decision.js";

describe("determineReviewDecision", () => {
  it("blocks on critical findings", () => {
    expect(
      determineReviewDecision([
        {
          severity: "critical",
          path: "src/app.ts",
          line: 12,
          title: "Unhandled error",
          comment: "Add a try/catch.",
        },
      ]),
    ).toBe("request_changes");
  });

  it("blocks on major findings", () => {
    expect(
      determineReviewDecision([
        {
          severity: "major",
          path: "src/app.ts",
          line: 12,
          title: "Missing validation",
          comment: "Validate the input before use.",
        },
      ]),
    ).toBe("request_changes");
  });

  it("approves when only non-blocking findings exist", () => {
    expect(
      determineReviewDecision([
        {
          severity: "minor",
          path: "src/app.ts",
          line: 12,
          title: "Small cleanup",
          comment: "Prefer a constant here.",
        },
        {
          severity: "improvement",
          path: "src/app.ts",
          line: 14,
          title: "Add a regression test",
          comment: "Cover the fallback path explicitly.",
        },
      ]),
    ).toBe("approve");
  });

  it("approves when there are no findings", () => {
    expect(determineReviewDecision([])).toBe("approve");
  });
});

describe("toReviewEvent", () => {
  it("maps request_changes to REQUEST_CHANGES", () => {
    expect(toReviewEvent("request_changes")).toBe("REQUEST_CHANGES");
  });

  it("maps approve to APPROVE", () => {
    expect(toReviewEvent("approve")).toBe("APPROVE");
  });
});

describe("sortFindingsBySeverity", () => {
  it("sorts findings from highest to lowest severity", () => {
    const findings = sortFindingsBySeverity([
      {
        severity: "improvement",
        path: "src/a.ts",
        line: 1,
        title: "Info",
        comment: "Info",
      },
      {
        severity: "critical",
        path: "src/a.ts",
        line: 1,
        title: "Critical",
        comment: "Critical",
      },
    ]);

    expect(findings.map((finding) => finding.severity)).toEqual(["critical", "improvement"]);
  });
});
