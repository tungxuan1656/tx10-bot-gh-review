import type { ReviewableFile } from "./types.js";

const maxFiles = 20;
const maxPatchCharacters = 4_000;
const maxContentCharacters = 6_000;

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
  files: ReviewableFile[];
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
    "Return JSON only.",
    "Do not include markdown fences or any prose outside the JSON object.",
    "Focus on concrete bugs, correctness issues, security issues, and missing validation.",
    "Ignore purely stylistic suggestions.",
    "Only report findings when you are confident and can point to a specific file path and line number visible in the provided diff context.",
    "",
    "Score rubric:",
    "- 0 means extremely risky or broken.",
    "- 10 means no actionable concerns.",
    "",
    "Decision guidance:",
    '- Use "request_changes" only when at least one finding is critical or high severity.',
    '- Use "comment" when findings are medium, low, or info only.',
    '- Use "approve" when there are no actionable findings.',
    "",
    `Repository: ${input.owner}/${input.repo}`,
    `Pull Request: #${input.pullNumber}`,
    `Title: ${input.title}`,
    `Head SHA: ${input.headSha}`,
    `Reviewable files included: ${selectedFiles.length}/${input.files.length}`,
    "",
    "Required JSON shape:",
    JSON.stringify(
      {
        summary: "string",
        score: 0,
        decision: "approve",
        findings: [
          {
            severity: "medium",
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
