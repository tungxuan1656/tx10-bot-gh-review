import type { ReviewableFile } from './types.js'

const maxPhase1OutputCharacters = 3_000
const maxPhase2OutputCharacters = 4_000
const maxPhaseDiffInputCharacters = 80_000
const baseRefName = 'refs/codex-review/base'
const headRefName = 'refs/codex-review/head'

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, maxLength)}\n...[truncated]`
}

function shellQuotePath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
}

function formatReviewablePathspec(paths: string[]): string {
  return paths.map((filePath) => shellQuotePath(filePath)).join(' ')
}

/** Phase 1: Ask Codex to summarise the PR from pr-info.yaml. Returns free-form markdown. */
export function buildPhase1Prompt(input: {
  owner: string
  repo: string
  pullNumber: number
  title: string
  headSha: string
  prInfoFilePath: string
}): string {
  return [
    'You are a senior engineer helping with a pull request review.',
    `Read the file \`${input.prInfoFilePath}\` from the repository root.`,
    'It contains structured metadata about the pull request.',
    '',
    'Write a concise markdown summary (max 10 sentences) covering:',
    '- What the PR is trying to achieve',
    '- Key files and commit messages',
    '- Any notable patterns or concerns visible from the metadata alone',
    '',
    'Output markdown only, no JSON. Do not include a code fence.',
    '',
    `Repository: ${input.owner}/${input.repo}`,
    `Pull Request: #${input.pullNumber}`,
    `Title: ${input.title}`,
    `Head SHA: ${input.headSha}`,
  ].join('\n')
}

/** Phase 2: Ask Codex to analyse the diff in context of the phase-1 summary. Returns free-form markdown. */
export function buildPhase2Prompt(input: {
  phase1Summary: string
  reviewablePaths: string[]
}): string {
  const pathspec = formatReviewablePathspec(input.reviewablePaths)

  return [
    'You are a senior engineer reviewing a pull request.',
    'You have already summarised the PR metadata.',
    `Now inspect the repository state directly using git between ${baseRefName} and ${headRefName}.`,
    'Only inspect supported reviewable files passed in the pathspec.',
    '',
    'Run these commands in the workspace:',
    `1. git diff --name-status ${baseRefName} ${headRefName} -- ${pathspec}`,
    `2. git diff --unified=5 ${baseRefName} ${headRefName} -- ${pathspec} | head -c ${maxPhaseDiffInputCharacters}`,
    '',
    'Using both the summary and the git diff output, describe:',
    '- The exact scope of changes (which modules, layers, APIs are touched)',
    '- The intent behind the changes (what problem they solve)',
    '- Any notable added, removed, or modified features or behaviours',
    '',
    'Output markdown only, no JSON. Do not include a code fence. Keep it under 20 sentences.',
    '',
    '## PR Summary (from phase 1)',
    truncate(input.phase1Summary, maxPhase1OutputCharacters),
  ].join('\n')
}

/** Phase 3: Deep review using code, diff, skills, and conversation history. Returns JSON. */
export function buildPhase3Prompt(input: {
  owner: string
  repo: string
  pullNumber: number
  title: string
  headSha: string
  changesOverview: string
  discussionFilePath: string
  reviewablePaths: string[]
}): string {
  const pathspec = formatReviewablePathspec(input.reviewablePaths)

  return [
    'You are reviewing a GitHub pull request.',
    'Use the `code-review` skill available in the workspace and follow it strictly for a rigorous review.',
    'Return JSON only.',
    'Do not include markdown fences or any prose outside the JSON object.',
    'Focus on concrete bugs, correctness issues, security issues, and missing validation.',
    'Ignore purely stylistic suggestions.',
    'Only report findings when you are confident and can point to a specific file path and line number visible in the diff context you inspect.',
    'Do not speculate. If evidence is insufficient, omit the finding.',
    `Before writing findings, read ${input.discussionFilePath} from the repository root and use it as historical context.`,
    'Treat resolved conversations and maintainer explanations as prior context, and avoid repeating issues that are already resolved.',
    '',
    'Repository inspection instructions:',
    `- First run: git diff --name-status ${baseRefName} ${headRefName} -- ${pathspec}`,
    `- Then inspect full patch: git diff --unified=5 ${baseRefName} ${headRefName} -- ${pathspec} | head -c ${maxPhaseDiffInputCharacters}`,
    `- For a specific file patch: git diff --unified=5 ${baseRefName} ${headRefName} -- <path>`,
    `- For current head content: git show ${headRefName}:<path>`,
    '- Only review supported reviewable files listed in the pathspec above.',
    '- Every finding must reference a changed file and a line grounded in a visible diff hunk.',
    '',
    'Score rubric:',
    '- 0 means extremely risky or broken.',
    '- 10 means no actionable concerns.',
    '',
    'Decision guidance:',
    '- Decision must be exactly "request_changes" or "approve".',
    '- Use "request_changes" when at least one finding is "critical" or "major".',
    '- Use "approve" when findings are only "minor" or "improvement", or when there are no findings.',
    '- Minor and improvement findings should still include concrete comments and fix guidance when present.',
    '',
    `Repository: ${input.owner}/${input.repo}`,
    `Pull Request: #${input.pullNumber}`,
    `Title: ${input.title}`,
    `Head SHA: ${input.headSha}`,
    '',
    '## Changes Overview (from diff analysis)',
    truncate(input.changesOverview, maxPhase2OutputCharacters),
    '',
    'Required JSON shape:',
    JSON.stringify(
      {
        summary: 'string',
        changesOverview:
          'string (copy the changes overview above, or refine it)',
        score: 0,
        decision: 'approve',
        findings: [
          {
            severity: 'minor',
            path: 'src/example.ts',
            line: 10,
            title: 'Short issue title',
            comment: 'Concrete explanation and fix guidance',
          },
        ],
      },
      null,
      2,
    ),
  ].join('\n')
}

/**
 * Backwards-compatible single-prompt builder.
 * Used by tests and any callers that have not yet migrated to the chained flow.
 */
export function buildReviewPrompt(input: {
  owner: string
  repo: string
  pullNumber: number
  title: string
  headSha: string
  diff: string
  files: ReviewableFile[]
  discussionContextMarkdown: string
  discussionFilePath: string
}): string {
  return buildPhase3Prompt({
    owner: input.owner,
    repo: input.repo,
    pullNumber: input.pullNumber,
    title: input.title,
    headSha: input.headSha,
    discussionFilePath: input.discussionFilePath,
    changesOverview: '',
    reviewablePaths: input.files.map((file) => file.path),
  })
}
