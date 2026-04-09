import { z } from "zod";

export const supportedPullRequestActions = [
  "opened",
  "reopened",
  "synchronize",
  "review_requested",
] as const;

export type SupportedPullRequestAction = (typeof supportedPullRequestActions)[number];

export function isSupportedPullRequestAction(
  action: string,
): action is SupportedPullRequestAction {
  return supportedPullRequestActions.includes(action as SupportedPullRequestAction);
}

export const findingSeveritySchema = z.enum([
  "critical",
  "high",
  "medium",
  "low",
  "info",
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
  decision: z.enum(["approve", "comment", "request_changes"]),
  findings: z.array(reviewFindingSchema),
});

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

export type PullRequestContext = {
  action: SupportedPullRequestAction;
  installationId: number;
  owner: string;
  repo: string;
  pullNumber: number;
  title: string;
  htmlUrl: string;
  headSha: string;
  baseSha: string;
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

export type ReviewEvent = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

export type PullRequestWebhookPayload = {
  action: SupportedPullRequestAction;
  installation: {
    id: number;
  };
  repository: {
    name: string;
    owner: {
      login: string;
    };
  };
  pull_request: {
    number: number;
    title: string;
    html_url: string;
    head: {
      sha: string;
    };
    base: {
      sha: string;
    };
  };
};

export type InlineReviewComment = {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
};
