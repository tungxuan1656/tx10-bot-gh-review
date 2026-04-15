import type { ReviewableFile } from "./types.js";

const maxFiles = 20;
const maxDiffCharacters = 20_000;
const maxPatchCharacters = 4_000;
const maxContentCharacters = 6_000;
const maxDiscussionCharacters = 20_000;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...[truncated]`;
}

export function buildReviewPrompt(input: {
  owner: string;
  repo: string;
  pullNumber: number;
  title: string;
  headSha: string;
  diff: string;
  files: ReviewableFile[];
  discussionContextMarkdown: string;
  discussionFilePath: string;
}): string {
  const selectedFiles = input.files.slice(0, maxFiles);

  const fileBlocks = selectedFiles
    .map((file) => {
      return [
        `FILE: ${file.path}`,
        "",
        "PATCH:",
        truncate(file.patch, maxPatchCharacters),
        "",
        "CURRENT FILE CONTENT:",
        truncate(file.content, maxContentCharacters),
      ].join("\n");
    })
    .join("\n\n---\n\n");

  return [
    "You are reviewing a GitHub pull request diff.",
    'Use the `code-review` skill available in the workspace and follow it strictly for a rigorous review.',
    "Return JSON only.",
    "Do not include markdown fences or any prose outside the JSON object.",
    "Focus on concrete bugs, correctness issues, security issues, and missing validation.",
    "Ignore purely stylistic suggestions.",
    "Only report findings when you are confident and can point to a specific file path and line number visible in the provided diff context.",
    `Before writing findings, read ${input.discussionFilePath} from the repository root and use it as historical context.`,
    "Treat resolved conversations and maintainer explanations as prior context, and avoid repeating issues that are already resolved.",
    "",
    "Score rubric:",
    "- 0 means extremely risky or broken.",
    "- 10 means no actionable concerns.",
    "",
    "Decision guidance:",
    '- Decision must be exactly "request_changes" or "approve".',
    '- Use "request_changes" when at least one finding is "critical" or "major".',
    '- Use "approve" when findings are only "minor" or "improvement", or when there are no findings.',
    '- Minor and improvement findings should still include concrete comments and fix guidance when present.',
    "",
    `Repository: ${input.owner}/${input.repo}`,
    `Pull Request: #${input.pullNumber}`,
    `Title: ${input.title}`,
    `Head SHA: ${input.headSha}`,
    `Reviewable files included: ${selectedFiles.length}/${input.files.length}`,
    "",
    "Unified diff (context=5):",
    truncate(input.diff, maxDiffCharacters),
    "",
    `Historical PR discussion snapshot (also written to ${input.discussionFilePath}):`,
    truncate(input.discussionContextMarkdown, maxDiscussionCharacters),
    "",
    "Required JSON shape:",
    JSON.stringify(
      {
        summary: "string",
        score: 0,
        decision: "approve",
        findings: [
          {
            severity: "minor",
            path: "src/example.ts",
            line: 10,
            title: "Short issue title",
            comment: "Concrete explanation and fix guidance",
          },
        ],
      },
      null,
      2,
    ),
    "",
    "Files:",
    fileBlocks,
  ].join("\n");
}
