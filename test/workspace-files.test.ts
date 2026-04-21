import { describe, expect, it } from 'vitest'

import {
  isReviewableChangedFile,
  parseChangedFiles,
  truncateDiff,
} from '../src/review/workspace-files.js'

describe('workspace file helpers', () => {
  it('parses regular, rename, and copy entries from git diff name-status output', () => {
    const result = parseChangedFiles(
      [
        'M',
        'src/app.ts',
        'R100',
        'src/old.ts',
        'src/new.ts',
        'C100',
        'src/template.ts',
        'src/template-copy.ts',
      ].join('\0') + '\0',
    )

    expect(result).toEqual([
      { path: 'src/app.ts', status: 'M' },
      { path: 'src/new.ts', status: 'R100' },
      { path: 'src/template-copy.ts', status: 'C100' },
    ])
  })

  it('filters out removed and non-reviewable files', () => {
    expect(
      isReviewableChangedFile({ path: 'src/app.ts', status: 'M' }),
    ).toBe(true)
    expect(
      isReviewableChangedFile({ path: 'README.md', status: 'M' }),
    ).toBe(true)
    expect(
      isReviewableChangedFile({ path: 'package-lock.json', status: 'M' }),
    ).toBe(false)
    expect(
      isReviewableChangedFile({ path: 'src/deleted.ts', status: 'D' }),
    ).toBe(false)
  })

  it('truncates overly large diffs with a sentinel', () => {
    const diff = 'a'.repeat(80_100)

    const result = truncateDiff(diff)

    expect(result).toContain('...[diff truncated]')
    expect(result.length).toBeLessThanOrEqual(80_000 + 30)
  })
})
