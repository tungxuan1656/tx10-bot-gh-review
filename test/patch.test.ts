import { describe, expect, it } from 'vitest'

import {
  getCommentableRightSideLines,
  isCommentableRightSideLine,
} from '../src/review/patch.js'

describe('patch helpers', () => {
  const patch = [
    '@@ -1,4 +1,5 @@',
    " import { oldThing } from './dep';",
    '-const debug = true;',
    '+const debug = false;',
    ' export function run() {',
    '+  return debug;',
    ' }',
  ].join('\n')

  it('tracks right-side lines in diff hunks', () => {
    expect(Array.from(getCommentableRightSideLines(patch))).toEqual([
      1, 2, 3, 4, 5,
    ])
  })

  it('knows whether a line can receive an inline comment', () => {
    expect(isCommentableRightSideLine(patch, 2)).toBe(true)
    expect(isCommentableRightSideLine(patch, 8)).toBe(false)
  })
})
