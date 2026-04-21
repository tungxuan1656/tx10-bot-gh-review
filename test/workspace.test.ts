import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTemporaryReviewWorkspaceManager } from '../src/review/workspace.js'
import type { PRInfoObject, PullRequestContext } from '../src/review/types.js'

const createdDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

async function runGit(args: string[], cwd: string): Promise<string> {
  const child = spawn('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutChunks.push(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk)
  })

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })

  if (exitCode !== 0) {
    throw new Error(Buffer.concat(stderrChunks).toString('utf8').trim())
  }

  return Buffer.concat(stdoutChunks).toString('utf8').trim()
}

async function createRemoteRepository(): Promise<{
  baseSha: string
  headSha: string
  remotePath: string
}> {
  const rootDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'workspace-manager-test-'),
  )
  createdDirectories.push(rootDirectory)

  const sourcePath = path.join(rootDirectory, 'source')
  const remotePath = path.join(rootDirectory, 'remote.git')

  await mkdir(path.join(sourcePath, 'src'), { recursive: true })
  await runGit(['init', '--initial-branch=main'], sourcePath)
  await runGit(['config', 'user.email', 'review-bot@example.com'], sourcePath)
  await runGit(['config', 'user.name', 'Review Bot'], sourcePath)

  await writeFile(
    path.join(sourcePath, 'src/app.ts'),
    "export const value = 'base';\n",
    'utf8',
  )
  await writeFile(path.join(sourcePath, 'README.md'), '# Base\n', 'utf8')
  await runGit(['add', 'src/app.ts', 'README.md'], sourcePath)
  await runGit(['commit', '-m', 'base'], sourcePath)
  const baseSha = await runGit(['rev-parse', 'HEAD'], sourcePath)

  await writeFile(
    path.join(sourcePath, 'src/app.ts'),
    "export const value = 'head';\n",
    'utf8',
  )
  await writeFile(path.join(sourcePath, 'README.md'), '# Head\n', 'utf8')
  await runGit(['add', 'src/app.ts', 'README.md'], sourcePath)
  await runGit(['commit', '-m', 'head'], sourcePath)
  const headSha = await runGit(['rev-parse', 'HEAD'], sourcePath)

  await runGit(['clone', '--bare', sourcePath, remotePath], rootDirectory)

  return {
    baseSha,
    headSha,
    remotePath,
  }
}

function createPullRequestContext(input: {
  baseSha: string
  headSha: string
  remotePath: string
}): PullRequestContext {
  return {
    action: 'review_requested',
    installationId: 0,
    owner: 'acme',
    repo: 'repo',
    pullNumber: 42,
    title: 'Example',
    htmlUrl: 'https://github.com/acme/repo/pull/42',
    headSha: input.headSha,
    headRef: 'main',
    headCloneUrl: input.remotePath,
    baseSha: input.baseSha,
    baseRef: 'main',
    baseCloneUrl: input.remotePath,
  }
}

describe('createTemporaryReviewWorkspaceManager', () => {
  it('materializes the PR repository into a temporary workspace and returns reviewable files', async () => {
    const repo = await createRemoteRepository()
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const manager = createTemporaryReviewWorkspaceManager({
      githubToken: 'unused',
      logger: logger as never,
      timeoutMs: 10_000,
    })

    const prInfo: PRInfoObject = {
      owner: 'acme',
      repo: 'repo',
      pullNumber: 42,
      title: 'Example',
      description: '',
      headSha: repo.headSha,
      baseSha: repo.baseSha,
      headRef: 'main',
      baseRef: 'main',
      htmlUrl: 'https://github.com/acme/repo/pull/42',
      commits: [{ sha: repo.headSha, message: 'head' }],
      changedFilePaths: ['src/app.ts'],
    }

    const workspace = await manager.prepareWorkspace(
      createPullRequestContext(repo),
      prInfo,
    )

    try {
      expect(workspace.workingDirectory).toContain('codex-review-workspace-')
      expect(workspace.reviewableFiles).toHaveLength(2)
      expect(workspace.reviewableFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'README.md' }),
          expect.objectContaining({ path: 'src/app.ts' }),
        ]),
      )

      const sourceFile = workspace.reviewableFiles.find(
        (file) => file.path === 'src/app.ts',
      )
      expect(sourceFile).toMatchObject({
        path: 'src/app.ts',
      })
      expect(sourceFile?.content).toContain('head')
      expect(sourceFile?.patch).toContain('@@')
      expect(workspace.diff).toContain('diff --git a/src/app.ts b/src/app.ts')

      // pr-info.yaml should be written to the workspace root
      const prInfoYaml = await readFile(
        path.join(workspace.workingDirectory, 'pr-info.yaml'),
        'utf8',
      )
      expect(prInfoYaml).toContain('owner: "acme"')
      expect(prInfoYaml).toContain('pull_number: 42')
      expect(prInfoYaml).toContain('changed_files:')

      // prInfo is returned on the workspace object
      expect(workspace.prInfo).toEqual(prInfo)

      const checkedOutFile = await readFile(
        path.join(workspace.workingDirectory, 'src/app.ts'),
        'utf8',
      )
      expect(checkedOutFile).toContain('head')

      const copiedSkill = await readFile(
        path.join(
          workspace.workingDirectory,
          '.agents/skills/code-review/SKILL.md',
        ),
        'utf8',
      )
      expect(copiedSkill).toContain('# Code Review')

      await expect(
        readFile(
          path.join(
            workspace.workingDirectory,
            '.agents/skills/api-design/SKILL.md',
          ),
          'utf8',
        ),
      ).resolves.toContain('API')
    } finally {
      const workingDirectory = workspace.workingDirectory
      await workspace.cleanup()
      await expect(
        readFile(path.join(workingDirectory, 'src/app.ts'), 'utf8'),
      ).rejects.toThrow()
    }
  })

  it('truncates the diff when it exceeds 80 000 characters', async () => {
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const manager = createTemporaryReviewWorkspaceManager({
      githubToken: 'unused',
      logger: logger as never,
      timeoutMs: 10_000,
    })

    // Overwrite src/app.ts in the remote with a file large enough to produce >80k diff chars.
    // The file must be changed between base and head, which is already the case in the fixture.
    // We re-use createRemoteRepository as-is; the diff for src/app.ts is small.
    // To force truncation we need a huge diff, so we create a separate large-file repo.
    const rootDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'workspace-truncate-test-'),
    )
    createdDirectories.push(rootDirectory)

    const sourcePath = path.join(rootDirectory, 'source')
    const remotePath = path.join(rootDirectory, 'remote.git')

    await mkdir(path.join(sourcePath, 'src'), { recursive: true })
    await runGit(['init', '--initial-branch=main'], sourcePath)
    await runGit(['config', 'user.email', 'review-bot@example.com'], sourcePath)
    await runGit(['config', 'user.name', 'Review Bot'], sourcePath)

    // base: large file filled with 'a'
    const bigContent = "const x = 'aaaa';\n".repeat(5_000) // ~90k chars
    await writeFile(path.join(sourcePath, 'src/big.ts'), bigContent, 'utf8')
    await runGit(['add', 'src/big.ts'], sourcePath)
    await runGit(['commit', '-m', 'base'], sourcePath)
    const baseSha = await runGit(['rev-parse', 'HEAD'], sourcePath)

    // head: same structure, different value
    const bigContentHead = "const x = 'bbbb';\n".repeat(5_000)
    await writeFile(path.join(sourcePath, 'src/big.ts'), bigContentHead, 'utf8')
    await runGit(['add', 'src/big.ts'], sourcePath)
    await runGit(['commit', '-m', 'head'], sourcePath)
    const headSha = await runGit(['rev-parse', 'HEAD'], sourcePath)

    await runGit(['clone', '--bare', sourcePath, remotePath], rootDirectory)

    const context: PullRequestContext = {
      action: 'review_requested',
      installationId: 0,
      owner: 'acme',
      repo: 'repo',
      pullNumber: 99,
      title: 'Large diff',
      htmlUrl: 'https://github.com/acme/repo/pull/99',
      headSha,
      headRef: 'main',
      headCloneUrl: remotePath,
      baseSha,
      baseRef: 'main',
      baseCloneUrl: remotePath,
    }

    const prInfo: PRInfoObject = {
      owner: 'acme',
      repo: 'repo',
      pullNumber: 99,
      title: 'Large diff',
      description: '',
      headSha,
      baseSha,
      headRef: 'main',
      baseRef: 'main',
      htmlUrl: 'https://github.com/acme/repo/pull/99',
      commits: [{ sha: headSha, message: 'head' }],
      changedFilePaths: ['src/big.ts'],
    }

    const workspace = await manager.prepareWorkspace(context, prInfo)

    try {
      expect(workspace.diff).toContain('...[diff truncated]')
      expect(workspace.diff.length).toBeLessThanOrEqual(80_000 + 30) // truncation sentinel length
    } finally {
      await workspace.cleanup()
    }
  })
})
