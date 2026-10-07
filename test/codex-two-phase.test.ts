import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  cleanupCodexTestArtifacts,
  createFailingFakeCodexBinary,
  createRunner,
  createTwoPhaseFakeCodexBinary,
  readJsonFile,
  testDiffOutput,
  testInspectionScope,
} from './codex-test-helpers.js'

vi.mock('../src/review/workspace-git.js', () => ({
  runCommand: vi.fn(() => Promise.resolve(testDiffOutput)),
}))

afterEach(async () => {
  await cleanupCodexTestArtifacts()
})

describe('createCodexRunner reviewTwoPhase', () => {
  it('runs the two-phase flow and passes phase one output into phase two prompt builder', async () => {
    const { binPath, capturePath } = await createTwoPhaseFakeCodexBinary({
      phase1Output: 'phase-one-summary',
      phase2Output: JSON.stringify({
        reviewStatus: 'complete',
        incompleteReason: '',
        summary: 'ok',
        changesOverview: '',
        score: 9,
        decision: 'approve',
        findings: [],
      }),
    })
    const { runner } = createRunner({
      bin: binPath,
      timeoutMs: 5_000,
    })
    const phase2Prompt = vi.fn((phase1Output: string) => `phase2:${phase1Output}`)

    const outcome = await runner.reviewTwoPhase({
      phase1Prompt: 'phase1',
      phase2Prompt,
      inspection: testInspectionScope,
      workingDirectory: '/tmp/pr-workspace',
    })

    expect(outcome).toEqual({
      ok: true,
      result: {
        summary: 'ok',
        changesOverview: '',
        score: 9,
        decision: 'approve',
        findings: [],
      },
    })
    expect(phase2Prompt).toHaveBeenCalledWith('phase-one-summary')

    const capture = await readJsonFile<Array<{ stdin: string }>>(capturePath)
    expect(capture).toHaveLength(2)
    expect(capture[0]?.stdin).toBe('phase1')
    expect(capture[1]?.stdin).toContain('phase2:phase-one-summary')
    expect(capture[1]?.stdin).toContain('Mandatory diff inspection:')
  })

  it('returns the phase one failure without running phase two', async () => {
    const binPath = await createFailingFakeCodexBinary({
      stderr: 'prompt is too long',
    })
    const { runner } = createRunner({
      bin: binPath,
      timeoutMs: 5_000,
    })
    const phase2Prompt = vi.fn()

    const outcome = await runner.reviewTwoPhase({
      phase1Prompt: 'phase1',
      phase2Prompt,
      inspection: testInspectionScope,
      workingDirectory: '/tmp/pr-workspace',
    })

    expect(outcome).toEqual({
      ok: false,
      reason: 'Codex returned a non-zero exit code.',
    })
    expect(phase2Prompt).not.toHaveBeenCalled()
  })
})
