import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { cleanupCodexTestArtifacts, createRunner } from './codex-test-helpers.js'
import { buildInspectionCommand } from '../src/review/codex-completion.js'

const execFileAsync = promisify(execFile)
const directories: string[] = []
const oddPath = "src/odd' $(touch injected).ts"

async function prepareRepository() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-inspection-'))
  directories.push(directory)
  const git = (...args: string[]) => execFileAsync('git', args, { cwd: directory })
  await git('init', '--initial-branch=main')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.com')
  await mkdir(path.join(directory, 'src'))
  await writeFile(path.join(directory, 'src/app.ts'), 'before\n')
  await writeFile(path.join(directory, oddPath), 'before\n')
  await git('add', '.')
  await git('commit', '-m', 'base')
  await git('update-ref', 'refs/codex-review/previous', 'HEAD')
  await git('checkout', '-b', 'feature')
  await writeFile(path.join(directory, 'src/app.ts'), 'after\n')
  await writeFile(path.join(directory, oddPath), 'after\n')
  await git('add', '.')
  await git('commit', '-m', 'feature')
  await git('update-ref', 'refs/codex-review/head', 'HEAD')
  await git('checkout', 'main')
  await writeFile(path.join(directory, 'base-only.ts'), 'unrelated base change\n')
  await git('add', '.')
  await git('commit', '-m', 'advance base')
  await git('update-ref', 'refs/codex-review/base', 'HEAD')
  await git('checkout', 'feature')

  const bin = path.join(directory, 'fake-codex.mjs')
  const capture = path.join(directory, 'capture.json')
  await writeFile(bin, `#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
const args = process.argv.slice(2);
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const command = prompt.split('Mandatory diff inspection:\\n')[1].split('\\n')[1];
const { stdout } = await promisify(execFile)('/bin/sh', ['-c', command]);
await writeFile(${JSON.stringify(capture)}, JSON.stringify({ command, stdout }));
console.log(JSON.stringify({ type: 'item.completed', item: {
  id: 'item_0', type: 'command_execution', command,
  status: 'completed', exit_code: 0, aggregated_output: stdout,
}}));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } }));
await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({
  reviewStatus: 'complete', incompleteReason: '', summary: 'No issues.', changesOverview: '',
  score: 9, decision: 'approve', findings: [],
}));
`)
  await chmod(bin, 0o755)
  return { bin, capture, directory, git }
}

afterEach(async () => {
  await cleanupCodexTestArtifacts()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe('Codex diff inspection with real Git', () => {
  it.runIf(process.platform === 'darwin')('uses the resolved Git executable instead of the macOS launcher', () => {
    const required = buildInspectionCommand('/tmp/pr-workspace', {
      range: 'refs/codex-review/base...refs/codex-review/head', paths: ['src/app.ts'],
    })
    expect(path.isAbsolute(required.bin)).toBe(true)
    expect(required.bin).not.toBe('/usr/bin/git')
    expect(required.command).toContain(`'${required.bin}' -C`)
  })

  it.each([
    'refs/codex-review/base...refs/codex-review/head',
    'refs/codex-review/previous..refs/codex-review/head',
  ])('verifies full output and safely quotes literal paths for %s', async (range) => {
    const { bin, capture, directory } = await prepareRepository()
    const { runner } = createRunner({ bin, timeoutMs: 5_000 })
    const outcome = await runner.review({
      prompt: 'Review', workingDirectory: directory,
      inspection: { range, paths: ['src/app.ts', oddPath] },
    })
    expect(outcome).toMatchObject({ ok: true, result: { decision: 'approve' } })
    const evidence = JSON.parse(await readFile(capture, 'utf8')) as { stdout: string }
    expect(evidence.stdout).toContain('src/app.ts')
    expect(evidence.stdout).toContain(oddPath)
    expect(evidence.stdout).not.toContain('base-only.ts')
    await expect(readFile(path.join(directory, 'injected'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts an empty re-review delta only after a successful inspection command', async () => {
    const { bin, capture, directory, git } = await prepareRepository()
    await git('update-ref', 'refs/codex-review/previous', 'refs/codex-review/head')
    const { runner } = createRunner({ bin, timeoutMs: 5_000 })
    const outcome = await runner.review({
      prompt: 'Review', workingDirectory: directory,
      inspection: { range: 'refs/codex-review/previous..refs/codex-review/head', paths: ['src/app.ts'] },
    })
    expect(outcome.ok).toBe(true)
    const evidence = JSON.parse(await readFile(capture, 'utf8')) as { stdout: string }
    expect(evidence.stdout).toBe('')
  })
})
