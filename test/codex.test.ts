import { describe, expect, it } from "vitest";

import { reviewResultSchema } from "../src/review/types.js";

describe("reviewResultSchema", () => {
  it("accepts the expected Codex response shape", () => {
    const parsed = reviewResultSchema.safeParse({
      summary: "Looks mostly good.",
      score: 8.5,
      decision: "comment",
      findings: [
        {
          severity: "medium",
          path: "src/app.ts",
          line: 14,
          title: "Unhandled JSON parsing",
          comment: "Wrap JSON.parse in try/catch.",
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects invalid finding shapes", () => {
    const parsed = reviewResultSchema.safeParse({
      summary: "Nope.",
      score: 12,
      decision: "approve",
      findings: [],
    });

    expect(parsed.success).toBe(false);
  });
});
