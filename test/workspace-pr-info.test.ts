import { describe, expect, it } from 'vitest'

import { serializePRInfoToYaml } from '../src/review/workspace-pr-info.js'
import type { PRInfoObject } from '../src/review/types.js'

describe('workspace PR info serialization', () => {
  it('serializes single-line values and escapes quotes', () => {
    const prInfo: PRInfoObject = {
      owner: 'acme',
      repo: 'repo',
      pullNumber: 42,
      title: 'Fix "quoted" title',
      description: '',
      headSha: 'abc123',
      baseSha: 'def456',
      headRef: 'feature/ref',
      baseRef: 'main',
      htmlUrl: 'https://github.com/acme/repo/pull/42',
      commits: [{ sha: 'abc123', message: 'short message' }],
      changedFilePaths: ['src/app.ts'],
    }

    const result = serializePRInfoToYaml(prInfo)

    expect(result).toContain('title: "Fix \\"quoted\\" title"')
    expect(result).toContain('description: "(none)"')
    expect(result).toContain('  - "src/app.ts"')
  })

  it('serializes multi-line values as literal blocks', () => {
    const prInfo: PRInfoObject = {
      owner: 'acme',
      repo: 'repo',
      pullNumber: 42,
      title: 'PR title',
      description: 'First line\nSecond line',
      headSha: 'abc123',
      baseSha: 'def456',
      headRef: 'feature/ref',
      baseRef: 'main',
      htmlUrl: 'https://github.com/acme/repo/pull/42',
      commits: [{ sha: 'abc123', message: 'Line one\nLine two' }],
      changedFilePaths: ['src/app.ts'],
    }

    const result = serializePRInfoToYaml(prInfo)

    expect(result).toContain('description: |-\n  First line\n  Second line')
    expect(result).toContain('message: |-\n  Line one\n  Line two')
  })
})
