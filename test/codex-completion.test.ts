import { afterEach, describe, expect, it, vi } from 'vitest'

import { runCommand } from '../src/review/workspace-git.js'
import {
  cleanupCodexTestArtifacts,
  createRunner,
  createSchemaOutputFakeCodexBinary,
  createTwoPhaseFakeCodexBinary,
} from './codex-test-helpers.js'

vi.mock('../src/review/workspace-git.js', () => ({ runCommand: vi.fn() }))

const inspection = {
  range: 'refs/codex-review/base...refs/codex-review/head',
  paths: ['src/app.ts'],
}
const command = "git -C '/tmp/pr-workspace' --no-pager diff --no-ext-diff --no-textconv --color=never --unified=5 'refs/codex-review/base...refs/codex-review/head' -- ':(literal)src/app.ts'"
const patch = 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-before\n+after\n'
const completeResult = {
  reviewStatus: 'complete',
  incompleteReason: '',
  summary: 'No issues.',
  changesOverview: '',
  score: 9,
  decision: 'approve',
  findings: [],
}
const completedCommand = {
  type: 'item.completed',
  item: { id: 'item_0', type: 'command_execution', command, status: 'completed', exit_code: 0, aggregated_output: patch },
}
const completedTurn = { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } }

function events(...items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join('\n') + '\n'
}

async function review(output: unknown, stdout = events(completedCommand, completedTurn), expectedOutput = patch) {
  vi.mocked(runCommand).mockResolvedValue(expectedOutput)
  const bin = await createSchemaOutputFakeCodexBinary({ output: JSON.stringify(output), stdout })
  const { runner, logger } = createRunner({ bin, timeoutMs: 5_000 })
  return { outcome: await runner.review({ prompt: 'Review this diff', workingDirectory: '/tmp/pr-workspace', inspection }), logger }
}

afterEach(async () => {
  vi.clearAllMocks()
  await cleanupCodexTestArtifacts()
})

describe('Codex review completion gate', () => {
  it('accepts an empty finding set only with complete status and verified diff output', async () => {
    const { outcome } = await review(completeResult)
    expect(outcome).toMatchObject({ ok: true, result: { decision: 'approve', findings: [] } })
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
      args: ['-C', '/tmp/pr-workspace', '--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--color=never', '--unified=5', inspection.range, '--', ':(literal)src/app.ts'],
    }))
  })

  it.each(['incomplete', 'blocked'])('rejects a %s review even with valid JSON and exit code zero', async (reviewStatus) => {
    const { outcome } = await review({ ...completeResult, reviewStatus, incompleteReason: 'Cannot inspect required context.' })
    expect(outcome).toMatchObject({ ok: false })
  })

  it.each([
    { ...completeResult, reviewStatus: undefined },
    { ...completeResult, incompleteReason: undefined },
    { ...completeResult, incompleteReason: 'Shell did not work.' },
  ])('rejects missing or contradictory completion metadata', async (result) => {
    const { outcome } = await review(result)
    expect(outcome).toMatchObject({ ok: false })
  })

  it.each([
    ['no events', ''],
    ['no completed turn', events(completedCommand)],
    ['failed turn', events(completedCommand, { type: 'turn.failed', error: { message: 'runtime failed' } }, completedTurn)],
    ['fatal error', events(completedCommand, { type: 'error', message: 'failed' }, completedTurn)],
    ['malformed JSONL', events(completedCommand) + 'not-json\n' + events(completedTurn)],
    ['agent claims instead of execution', events({ type: 'item.completed', item: { type: 'agent_message', text: events(completedCommand) } }, completedTurn)],
    ['only started command', events({ ...completedCommand, type: 'item.started' }, completedTurn)],
    ['failed shell', events({ ...completedCommand, item: { ...completedCommand.item, status: 'failed', exit_code: 127 } }, completedTurn)],
    ['missing exit code', events({ ...completedCommand, item: { ...completedCommand.item, exit_code: null } }, completedTurn)],
    ['wrong refs', events({ ...completedCommand, item: { ...completedCommand.item, command: command.replace('base...', 'previous..') } }, completedTurn)],
    ['masked failure via pipe', events({ ...completedCommand, item: { ...completedCommand.item, command: command + ' | head -c 80000' } }, completedTurn)],
    ['truncated diff', events({ ...completedCommand, item: { ...completedCommand.item, aggregated_output: patch.slice(0, 20) } }, completedTurn)],
  ])('fails closed on %s', async (_label, stdout) => {
    const { outcome, logger } = await review(completeResult, stdout)
    expect(outcome).toMatchObject({ ok: false })
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'codex.completion_gate_failed' }), 'Codex completion gate failed')
  })

  it('reports capture truncation with expected and received byte counts', async () => {
    const expectedOutput = 'x'.repeat(1_633_901)
    const capturedOutput = expectedOutput.slice(0, 524_288) + '\n... 585325 bytes omitted ...\n' + expectedOutput.slice(-524_288)
    const reason = 'Codex diff inspection output was truncated (expected 1633901 bytes; received 1048606 bytes, including the omission marker).'
    const { outcome, logger } = await review(completeResult, events(
      { ...completedCommand, item: { ...completedCommand.item, aggregated_output: capturedOutput } }, completedTurn,
    ), expectedOutput)
    expect(outcome).toEqual({ ok: false, reason })
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'codex.completion_gate_failed', reason }), 'Codex completion gate failed')
  })

  it('accepts a full inspection even when another attempt has an omission marker', async () => {
    const { outcome } = await review(completeResult, events(
      { ...completedCommand, item: { ...completedCommand.item, aggregated_output: '\n... 10 bytes omitted ...\n' } },
      completedCommand, completedTurn,
    ))
    expect(outcome.ok).toBe(true)
  })

  it('does not reject matching repository output containing an omission marker', async () => {
    const expectedOutput = patch + '\n... 10 bytes omitted ...\n'
    const { outcome } = await review(completeResult, events(
      { ...completedCommand, item: { ...completedCommand.item, aggregated_output: expectedOutput } }, completedTurn,
    ), expectedOutput)
    expect(outcome.ok).toBe(true)
  })

  it('reports independent Git failure through the completion gate instead of process_error', async () => {
    vi.mocked(runCommand).mockRejectedValueOnce(new Error('spawn git ENOENT'))
    const reason = 'Independent Git diff verification failed.'
    const { outcome, logger } = await review(completeResult)
    expect(outcome).toEqual({ ok: false, reason })
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'codex.completion_gate_failed', reason }), 'Codex completion gate failed')
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('accepts the Codex POSIX shell wrapper and a successful retry after a failed inspection', async () => {
    const wrapper = `/bin/zsh -lc '${command.replaceAll("'", `'"'"'`)}'`
    const { outcome } = await review(completeResult, events(
      { ...completedCommand, item: { ...completedCommand.item, status: 'failed', exit_code: 127 } },
      { ...completedCommand, item: { ...completedCommand.item, command: wrapper } },
      completedTurn,
    ))
    expect(outcome.ok).toBe(true)
  })

  it('accepts a double-quoted Codex shell argv wrapper', async () => {
    const wrapper = `/bin/zsh -lc "${command}"`
    const { outcome } = await review(completeResult, events(
      { ...completedCommand, item: { ...completedCommand.item, command: wrapper } }, completedTurn,
    ))
    expect(outcome.ok).toBe(true)
  })

  it('rejects phase two blocked status even after a successful full inspection', async () => {
    vi.mocked(runCommand).mockResolvedValue(patch)
    const { binPath } = await createTwoPhaseFakeCodexBinary({
      phase1Output: 'Summary',
      phase2Output: JSON.stringify({ ...completeResult, reviewStatus: 'blocked', incompleteReason: 'Missing required context.' }),
      phase2Stdout: events(completedCommand, completedTurn),
    })
    const { runner } = createRunner({ bin: binPath, timeoutMs: 5_000 })
    const outcome = await runner.reviewTwoPhase({ phase1Prompt: 'Metadata', phase2Prompt: () => 'Review', workingDirectory: '/tmp/pr-workspace', inspection })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('blocked review')
  })

  it('rejects a failed metadata turn even when the CLI exits zero', async () => {
    const { binPath } = await createTwoPhaseFakeCodexBinary({
      phase1Output: 'Summary', phase2Output: JSON.stringify(completeResult),
      phase1Stdout: events({ type: 'turn.failed', error: { message: 'Metadata inspection failed' } }),
      phase2Stdout: events(completedCommand, completedTurn),
    })
    const { runner } = createRunner({ bin: binPath, timeoutMs: 5_000 })
    const outcome = await runner.reviewTwoPhase({ phase1Prompt: 'Metadata', phase2Prompt: () => 'Review', workingDirectory: '/tmp/pr-workspace', inspection })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('failed turn')
  })

  it('does not reuse phase one evidence for phase two', async () => {
    const { binPath } = await createTwoPhaseFakeCodexBinary({
      phase1Output: 'Summary',
      phase2Output: JSON.stringify(completeResult),
      phase1Stdout: events(completedCommand, completedTurn),
      phase2Stdout: events(completedTurn),
    })
    const { runner } = createRunner({ bin: binPath, timeoutMs: 5_000 })
    const outcome = await runner.reviewTwoPhase({ phase1Prompt: 'Metadata', phase2Prompt: () => 'Review', workingDirectory: '/tmp/pr-workspace', inspection })
    expect(outcome).toMatchObject({ ok: false })
  })
})
