import { z } from "zod";

export const findingSeveritySchema = z.enum([
  "critical",
  "major",
  "minor",
  "improvement",
]);

export const reviewFindingSchema = z.object({
  severity: findingSeveritySchema,
  path: z.string().min(1),
  line: z.number().int().positive(),
  title: z.string().min(1),
  comment: z.string().min(1),
});

export const reviewResultSchema = z.object({
  summary: z.string().min(1),
  score: z.number().min(0).max(10),
  decision: z.enum(["approve", "request_changes"]),
  findings: z.array(reviewFindingSchema),
});

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

export type PullRequestContext = {
  action: string;
  installationId: number;
  owner: string;
  repo: string;
  pullNumber: number;
  title: string;
  htmlUrl: string;
  headSha: string;
  headRef: string;
  headCloneUrl: string;
  baseSha: string;
  baseRef: string;
  baseCloneUrl: string;
};

export type GitHubPullRequestFile = {
  path: string;
  status: string;
  patch?: string;
};

export type ReviewableFile = {
  path: string;
  patch: string;
  content: string;
};

export type CodexReviewSuccess = {
  ok: true;
  result: ReviewResult;
};

export type CodexReviewFailure = {
  ok: false;
  reason: string;
};

export type CodexReviewOutcome = CodexReviewSuccess | CodexReviewFailure;

export type ReviewDecision = z.infer<typeof reviewResultSchema.shape.decision>;

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES";

export type InlineReviewComment = {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
};
