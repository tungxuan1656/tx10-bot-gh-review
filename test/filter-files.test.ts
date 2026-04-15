import { describe, expect, it } from 'vitest'

import {
  filterReviewableFiles,
  isReviewableFilePath,
} from '../src/review/filter-files.js'

describe('isReviewableFilePath', () => {
  it('accepts supported source files', () => {
    expect(isReviewableFilePath('src/review/service.ts')).toBe(true)
    expect(isReviewableFilePath('app/main.py')).toBe(true)
  })

  it('rejects ignored directories and lock files', () => {
    expect(isReviewableFilePath('dist/index.js')).toBe(false)
    expect(isReviewableFilePath('node_modules/pkg/index.ts')).toBe(false)
    expect(isReviewableFilePath('pnpm-lock.yaml')).toBe(false)
  })
})

describe('filterReviewableFiles', () => {
  it('keeps only patchable, supported files', () => {
    const filtered = filterReviewableFiles([
      {
        path: 'src/app.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-console.log()\n+logger.info()',
      },
      {
        path: 'README.md',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-old\n+new',
      },
      { path: 'src/deleted.ts', status: 'removed', patch: '@@ -1 +0,0 @@' },
      { path: 'src/no-patch.ts', status: 'modified' },
    ])

    expect(filtered).toEqual([
      {
        path: 'src/app.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-console.log()\n+logger.info()',
      },
    ])
  })
})
