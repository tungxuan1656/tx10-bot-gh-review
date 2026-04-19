import { describe, expect, it } from 'vitest'

import {
  buildInitialReviewPhase2Prompt,
  buildPhase1Prompt,
  buildReReviewPrompt,
} from '../src/review/prompt.js'

describe('prompt builders', () => {
  it('builds initial review phase-1 prompt from pr-info metadata', () => {
    const prompt = buildPhase1Prompt({
      owner: 'acme',
      repo: 'repo',
      pullNumber: 42,
      title: 'Improve validation',
      headSha: 'abc123',
      prInfoFilePath: 'pr-info.yaml',
    })

    expect(prompt).toContain('Read the file `pr-info.yaml`')
    expect(prompt).toContain('Write a concise markdown summary')
  })

  it('builds initial review phase-2 prompt requiring code-review skill references', () => {
    const prompt = buildInitialReviewPhase2Prompt({
      owner: 'acme',
      repo: 'repo',
      pullNumber: 42,
      title: 'Improve validation',
      headSha: 'abc123',
      phase1Summary: 'Summary text',
      discussionFilePath: 'pr-review-comments.md',
      reviewablePaths: ['src/review/service.ts'],
    })

    expect(prompt).toContain('.agents/skills/code-review/SKILL.md')
    expect(prompt).toContain(
      '.agents/skills/code-review/references/review-playbook.md',
    )
    expect(prompt).toContain('Required JSON shape:')
    expect(prompt).toContain('changesOverview')
    expect(prompt).toContain(
      "git diff --name-status refs/codex-review/base refs/codex-review/head -- 'src/review/service.ts'",
    )
  })

  it('builds re-review prompt focused on delta range and fallback visibility', () => {
    const prompt = buildReReviewPrompt({
      owner: 'acme',
      repo: 'repo',
      pullNumber: 42,
      title: 'Improve validation',
      headSha: 'abc123',
      discussionFilePath: 'pr-review-comments.md',
      reviewablePaths: ['src/review/service.ts'],
      deltaFromRef: 'refs/codex-review/base',
      deltaToRef: 'refs/codex-review/head',
      deltaFromSha: 'def456',
      fallbackReason: 'previous_review_sha_not_fetchable',
    })

    expect(prompt).toContain('fast re-review')
    expect(prompt).toContain(
      'Delta range: refs/codex-review/base..refs/codex-review/head',
    )
    expect(prompt).toContain(
      'Delta fallback applied: previous_review_sha_not_fetchable',
    )
    expect(prompt).toContain('Do not re-review the entire PR from scratch')
  })
})
