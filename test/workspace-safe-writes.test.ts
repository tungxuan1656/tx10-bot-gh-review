import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { persistDiscussionContext } from '../src/review/discussion-cache.js'
import { copyReviewSkillsToWorkspace } from '../src/review/workspace-review-skills.js'
import type { AppLogger } from '../src/types/app.js'
import type { PullRequestContext } from '../src/review/types.js'

const directories: string[] = []
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as AppLogger

async function createDirectories() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-safe-writes-'))
  directories.push(root)
  const workingDirectory = path.join(root, 'workspace')
  const outside = path.join(root, 'outside')
  await mkdir(workingDirectory)
  await mkdir(outside)
  return { root, workingDirectory, outside }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('bot-owned workspace paths', () => {
  it.each(['.agents', '.agents/skills', '.agents/skills/code-review'])('does not follow a PR symlink at %s when copying trusted skills', async (reservedPath) => {
    const { root, workingDirectory, outside } = await createDirectories()
    const projectRoot = path.join(root, 'service')
    const source = path.join(projectRoot, 'resources/review-skills/code-review')
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'SKILL.md'), 'trusted review instructions')
    const sentinel = path.join(outside, 'SKILL.md')
    await writeFile(sentinel, 'do not overwrite')
    const destination = path.join(workingDirectory, reservedPath)
    await mkdir(path.dirname(destination), { recursive: true })
    await symlink(outside, destination)

    await copyReviewSkillsToWorkspace({ projectRoot, workingDirectory })

    expect(await readFile(sentinel, 'utf8')).toBe('do not overwrite')
    expect(await readFile(path.join(workingDirectory, '.agents/skills/code-review/SKILL.md'), 'utf8')).toBe('trusted review instructions')
    expect((await lstat(path.join(workingDirectory, '.agents'))).isSymbolicLink()).toBe(false)
  })

  it('replaces a PR discussion symlink without overwriting its host target', async () => {
    const { root, workingDirectory, outside } = await createDirectories()
    const sentinel = path.join(outside, 'host-file')
    await writeFile(sentinel, 'do not overwrite')
    const destination = path.join(workingDirectory, 'pr-review-comments.md')
    await symlink(sentinel, destination)

    await persistDiscussionContext({
      context: { owner: 'acme', repo: 'repo', pullNumber: 42, headSha: 'abc123' } as PullRequestContext,
      discussionMarkdown: '# Trusted discussion snapshot',
      runLogger: logger,
      workingDirectory,
      options: { discussionCacheDirectory: path.join(root, 'cache') },
    })

    expect(await readFile(sentinel, 'utf8')).toBe('do not overwrite')
    expect(await readFile(destination, 'utf8')).toBe('# Trusted discussion snapshot')
    expect((await lstat(destination)).isSymbolicLink()).toBe(false)
  })
})
