import { describe, expect, it } from "vitest";

import { determineReviewEvent, sortFindingsBySeverity } from "../src/review/decision.js";

describe("determineReviewEvent", () => {
  it("blocks on high severity findings", () => {
    expect(
      determineReviewEvent([
        {
          severity: "high",
          path: "src/app.ts",
          line: 12,
          title: "Unhandled error",
          comment: "Add a try/catch.",
        },
      ]),
    ).toBe("REQUEST_CHANGES");
  });

  it("comments when only non-blocking findings exist", () => {
    expect(
      determineReviewEvent([
        {
          severity: "low",
          path: "src/app.ts",
          line: 12,
          title: "Small cleanup",
          comment: "Prefer a constant here.",
        },
      ]),
    ).toBe("COMMENT");
  });

  it("approves when there are no findings", () => {
    expect(determineReviewEvent([])).toBe("APPROVE");
  });
});

describe("sortFindingsBySeverity", () => {
  it("sorts findings from highest to lowest severity", () => {
    const findings = sortFindingsBySeverity([
      {
        severity: "info",
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

    expect(findings.map((finding) => finding.severity)).toEqual(["critical", "info"]);
  });
});
