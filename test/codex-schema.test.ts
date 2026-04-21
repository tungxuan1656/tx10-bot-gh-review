import { afterEach, describe, expect, it } from 'vitest'

import { reviewResultSchema } from '../src/review/types.js'
import { cleanupCodexTestArtifacts } from './codex-test-helpers.js'

afterEach(async () => {
  await cleanupCodexTestArtifacts()
})

describe('reviewResultSchema', () => {
  it('accepts the expected Codex response shape', () => {
    const parsed = reviewResultSchema.safeParse({
      summary: 'Looks mostly good.',
      changesOverview: '',
      score: 8.5,
      decision: 'approve',
      findings: [
        {
          severity: 'minor',
          path: 'src/app.ts',
          line: 14,
          title: 'Unhandled JSON parsing',
          comment: 'Wrap JSON.parse in try/catch.',
        },
      ],
    })

    expect(parsed.success).toBe(true)
  })

  it('rejects invalid finding shapes', () => {
    const parsed = reviewResultSchema.safeParse({
      summary: 'Nope.',
      score: 12,
      decision: 'approve',
      findings: [],
    })

    expect(parsed.success).toBe(false)
  })

  it('rejects legacy decision and severity values', () => {
    const parsed = reviewResultSchema.safeParse({
      summary: 'Legacy response.',
      score: 8,
      decision: 'comment',
      findings: [
        {
          severity: 'medium',
          path: 'src/app.ts',
          line: 14,
          title: 'Legacy severity',
          comment: 'Old taxonomy should fail.',
        },
      ],
    })

    expect(parsed.success).toBe(false)
  })

  it('accepts explicit and missing changesOverview values', () => {
    const withOverview = reviewResultSchema.safeParse({
      summary: 'Looks good.',
      changesOverview: 'Added a new validation step.',
      score: 9,
      decision: 'approve',
      findings: [],
    })
    expect(withOverview.success).toBe(true)

    const withoutOverview = reviewResultSchema.parse({
      summary: 'Looks good.',
      score: 9,
      decision: 'approve',
      findings: [],
    })
    expect(withoutOverview.changesOverview).toBe('')
  })
})
