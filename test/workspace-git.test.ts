import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  fetchRevision,
  redactCommandOutput,
  runCommand,
} from '../src/review/workspace-git.js'

const createdDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function createNodeScript(
  fileName: string,
  lines: string[],
): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workspace-git-test-'))
  createdDirectories.push(directory)
  const scriptPath = path.join(directory, fileName)

  await writeFile(scriptPath, lines.join('\n'), 'utf8')
  await chmod(scriptPath, 0o755)

  return scriptPath
}

describe('workspace git helpers', () => {
  it('passes credentials only in the fetch environment, not command args or git config', async () => {
    const scriptPath = await createNodeScript('git.mjs', [
      '#!/usr/bin/env node',
      "import { writeFile } from 'node:fs/promises';",
      'const args = process.argv.slice(2);',
      'if (args[0] === "fetch") await writeFile(new URL("capture.json", import.meta.url), JSON.stringify({ args, count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 }));',
      'if (args[0] === "rev-parse") console.log("expected-sha");',
    ])

    await fetchRevision({
      cwd: path.dirname(scriptPath),
      gitBin: scriptPath,
      remote: 'origin',
      revision: 'expected-sha',
      fallbackRef: 'main',
      localRef: 'refs/codex-review/base',
      githubToken: 'secret-token',
      redactions: ['secret-token'],
      timeoutMs: 5_000,
    })

    const capture = JSON.parse(await readFile(path.join(path.dirname(scriptPath), 'capture.json'), 'utf8')) as {
      args: string[]; count: string; key: string; value: string
    }
    expect(capture.args.join(' ')).not.toContain('secret-token')
    expect(capture.args).not.toContain('--depth=1')
    expect(capture.count).toBe('1')
    expect(capture.key).toBe('http.https://github.com/.extraheader')
    expect(capture.value).toBe(`AUTHORIZATION: basic ${Buffer.from('x-access-token:secret-token').toString('base64')}`)
  })

  it('redacts raw and url-embedded tokens from command output', () => {
    const result = redactCommandOutput(
      'token secret-token https://x-access-token:secret-token@github.com/acme/repo.git',
      ['secret-token'],
    )

    expect(result).not.toContain('secret-token')
    expect(result).toContain('x-access-token:***@github.com')
  })

  it('throws a redacted error when the command fails', async () => {
    const scriptPath = await createNodeScript('fail.mjs', [
      '#!/usr/bin/env node',
      "console.error('token secret-token exploded')",
      'process.exit(1)',
    ])

    await expect(
      runCommand({
        args: [scriptPath],
        bin: 'node',
        cwd: process.cwd(),
        redactions: ['secret-token'],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow('token *** exploded')
  })

  it('times out long-running commands', async () => {
    const scriptPath = await createNodeScript('sleep.mjs', [
      '#!/usr/bin/env node',
      'await new Promise((resolve) => setTimeout(resolve, 200))',
    ])

    await expect(
      runCommand({
        args: [scriptPath],
        bin: 'node',
        cwd: process.cwd(),
        timeoutMs: 50,
      }),
    ).rejects.toThrow('Command timed out: node')
  })
})
