import type { ReviewableFile } from './types.js'

const maxPhase1OutputCharacters = 3_000
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

/**
 * Initial review phase 2: deep review in JSON.
 * Requires reading the bundled code-review skill and references first.
 */
export function buildInitialReviewPhase2Prompt(input: {
  owner: string
  repo: string
  pullNumber: number
  title: string
  headSha: string
  phase1Summary: string
  discussionFilePath: string
  reviewablePaths: string[]
}): string {
  const pathspec = formatReviewablePathspec(input.reviewablePaths)

  return [
    'You are reviewing a GitHub pull request.',
    'You already have a metadata summary from phase 1.',
    'Before reviewing, you MUST read and follow these files in the workspace:',
    '- .agents/skills/code-review/SKILL.md',
    '- .agents/skills/code-review/references/review-playbook.md',
    '- .agents/skills/code-review/references/rule-catalog.md',
    '- .agents/skills/code-review/references/severity-confidence-rubric.md',
    '- .agents/skills/code-review/references/output-contract.md',
    `Before writing findings, read ${input.discussionFilePath} from the repository root and use it as historical context.`,
    'Treat resolved conversations and maintainer explanations as prior context, and avoid repeating issues that are already resolved.',
    'Return JSON only.',
    'Do not include markdown fences or any prose outside the JSON object.',
    'Focus on concrete bugs, correctness issues, security issues, and missing validation.',
    'Ignore purely stylistic suggestions.',
    'Only report findings when you are confident and can point to a specific file path and line number visible in the diff context you inspect.',
    'Do not speculate. If evidence is insufficient, omit the finding.',
    '',
    'Repository inspection instructions:',
    `- First run: git diff --name-status ${baseRefName} ${headRefName} -- ${pathspec}`,
    `- Then inspect full patch: git diff --unified=5 ${baseRefName} ${headRefName} -- ${pathspec} | head -c ${maxPhaseDiffInputCharacters}`,
    `- For a specific file patch (start): git diff --unified=5 ${baseRefName} ${headRefName} -- <path>`,
    `- If context is insufficient for a confident finding, rerun for that file with: git diff --unified=20 ${baseRefName} ${headRefName} -- <path>`,
    `- If still insufficient, rerun for that file with: git diff --unified=60 ${baseRefName} ${headRefName} -- <path>`,
    `- If still unclear around function boundaries, run: git diff -W ${baseRefName} ${headRefName} -- <path>`,
    `- For current head content: git show ${headRefName}:<path>`,
    '- Only review supported reviewable files listed in the pathspec above.',
    '- Every finding must reference a changed file and a line grounded in a visible diff hunk.',
    '- Do not emit a finding until you have gathered enough context using the escalation steps above.',
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
    '## PR Summary (from phase 1)',
    truncate(input.phase1Summary, maxPhase1OutputCharacters),
    '',
    'Required JSON shape:',
    JSON.stringify(
      {
        summary: 'string',
        changesOverview:
          'string (optional; include only when it adds value, otherwise omit this key)',
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

/** Re-review fast path: focus on commits since previous reviewed SHA and unresolved prior findings. */
export function buildReReviewPrompt(input: {
  owner: string
  repo: string
  pullNumber: number
  title: string
  headSha: string
  discussionFilePath: string
  reviewablePaths: string[]
  deltaFromRef: string
  deltaToRef: string
  deltaFromSha: string | null
  fallbackReason: string | null
}): string {
  const pathspec = formatReviewablePathspec(input.reviewablePaths)

  return [
    'You are performing a fast re-review for a GitHub pull request after a new manual review request.',
    'Return JSON only.',
    'Do not include markdown fences or prose outside the JSON object.',
    '',
    'Primary objective:',
    '- Focus on changes since the last successful bot-reviewed commit.',
    '- Verify whether previously raised blocking issues appear fixed based on new changes and discussion context.',
    '- Do not re-review the entire PR from scratch unless fallback is explicitly required.',
    '',
    `Before writing findings, read ${input.discussionFilePath} from the repository root.`,
    'Use it to identify prior bot concerns, maintainer replies, and unresolved threads.',
    '',
    'Repository inspection instructions:',
    `- Delta range: ${input.deltaFromRef}..${input.deltaToRef}`,
    ...(input.deltaFromSha
      ? [`- Previous reviewed SHA: ${input.deltaFromSha}`]
      : ['- Previous reviewed SHA: unavailable']),
    ...(input.fallbackReason
      ? [`- Delta fallback applied: ${input.fallbackReason}`]
      : ['- Delta fallback applied: no']),
    `- First run: git diff --name-status ${input.deltaFromRef} ${input.deltaToRef} -- ${pathspec}`,
    `- Then inspect patch: git diff --unified=5 ${input.deltaFromRef} ${input.deltaToRef} -- ${pathspec} | head -c ${maxPhaseDiffInputCharacters}`,
    `- If needed for confidence: git diff --unified=20 ${input.deltaFromRef} ${input.deltaToRef} -- <path>`,
    `- If still needed: git diff -W ${input.deltaFromRef} ${input.deltaToRef} -- <path>`,
    `- For current file content: git show ${headRefName}:<path>`,
    '',
    'Finding policy:',
    '- Focus on regressions, still-unfixed blocking issues, and new correctness/security defects introduced by delta commits.',
    '- Ignore purely stylistic suggestions.',
    '- Omit findings without concrete diff-based evidence.',
    '',
    'Decision guidance:',
    '- Decision must be exactly "request_changes" or "approve".',
    '- Use "request_changes" when at least one finding is "critical" or "major".',
    '- Use "approve" when findings are only "minor"/"improvement" or there are no findings.',
    '',
    `Repository: ${input.owner}/${input.repo}`,
    `Pull Request: #${input.pullNumber}`,
    `Title: ${input.title}`,
    `Head SHA: ${input.headSha}`,
    '',
    'Required JSON shape:',
    JSON.stringify(
      {
        summary: 'string',
        changesOverview:
          'string (optional; include only when it adds value, otherwise omit this key)',
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

/** @deprecated Kept temporarily for compatibility with callers not yet migrated. */
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
  return buildInitialReviewPhase2Prompt({
    owner: input.owner,
    repo: input.repo,
    pullNumber: input.pullNumber,
    title: input.title,
    headSha: input.headSha,
    phase1Summary: input.changesOverview,
    discussionFilePath: input.discussionFilePath,
    reviewablePaths: input.reviewablePaths,
  })
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
  return buildInitialReviewPhase2Prompt({
    owner: input.owner,
    repo: input.repo,
    pullNumber: input.pullNumber,
    title: input.title,
    headSha: input.headSha,
    discussionFilePath: input.discussionFilePath,
    phase1Summary: '',
    reviewablePaths: input.files.map((file) => file.path),
  })
}
