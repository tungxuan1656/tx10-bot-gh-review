import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildAuthenticatedRemoteUrl,
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
  it('adds GitHub credentials only to http urls', () => {
    expect(
      buildAuthenticatedRemoteUrl(
        'https://github.com/acme/repo.git',
        'secret-token',
      ),
    ).toBe('https://x-access-token:secret-token@github.com/acme/repo.git')

    expect(
      buildAuthenticatedRemoteUrl('git@github.com:acme/repo.git', 'secret-token'),
    ).toBe('git@github.com:acme/repo.git')
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
