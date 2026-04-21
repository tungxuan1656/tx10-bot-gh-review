import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  copyReviewSkillsToWorkspaceMock,
  fetchRevisionMock,
  runCommandMock,
} = vi.hoisted(() => ({
  copyReviewSkillsToWorkspaceMock: vi.fn(),
  fetchRevisionMock: vi.fn(),
  runCommandMock: vi.fn(),
}))

vi.mock('../src/review/workspace-git.js', () => ({
  buildAuthenticatedRemoteUrl: vi.fn((cloneUrl: string, githubToken: string) =>
    `${cloneUrl}?token=${githubToken}`,
  ),
  fetchRevision: fetchRevisionMock,
  runCommand: runCommandMock,
}))

vi.mock('../src/review/workspace-review-skills.js', () => ({
  copyReviewSkillsToWorkspace: copyReviewSkillsToWorkspaceMock,
}))

import {
  prepareWorkspaceArtifacts,
  prepareWorkspaceRepository,
} from '../src/review/workspace-prepare.js'
import type { PRInfoObject, PullRequestContext } from '../src/review/types.js'

const createdDirectories: string[] = []

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

beforeEach(() => {
  fetchRevisionMock.mockResolvedValue(undefined)
  copyReviewSkillsToWorkspaceMock.mockResolvedValue(undefined)
})

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }
}

function createContext(
  overrides: Partial<PullRequestContext> = {},
): PullRequestContext {
  return {
    action: 'review_requested',
    installationId: 0,
    owner: 'acme',
    repo: 'repo',
    pullNumber: 42,
    title: 'Example',
    htmlUrl: 'https://github.com/acme/repo/pull/42',
    headSha: 'head-sha',
    headRef: 'feature/ref',
    headCloneUrl: 'https://github.com/acme/head.git',
    baseSha: 'base-sha',
    baseRef: 'main',
    baseCloneUrl: 'https://github.com/acme/base.git',
    ...overrides,
  }
}

function createPrInfo(
  overrides: Partial<PRInfoObject> = {},
): PRInfoObject {
  return {
    owner: 'acme',
    repo: 'repo',
    pullNumber: 42,
    title: 'Example',
    description: '',
    headSha: 'head-sha',
    baseSha: 'base-sha',
    headRef: 'feature/ref',
    baseRef: 'main',
    htmlUrl: 'https://github.com/acme/repo/pull/42',
    commits: [{ sha: 'head-sha', message: 'head commit' }],
    changedFilePaths: ['src/app.ts'],
    ...overrides,
  }
}

function createRuntime() {
  return {
    commandRedactions: ['secret'],
    gitBin: 'git',
    githubToken: 'secret',
    timeoutMs: 5_000,
  }
}

async function createWorkspaceDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workspace-prepare-'))
  createdDirectories.push(directory)
  return directory
}

describe('workspace prepare helpers', () => {
  it('initializes the repository for workspace preparation', async () => {
    runCommandMock.mockResolvedValue('')

    await prepareWorkspaceRepository({
      runtime: createRuntime(),
      workingDirectory: '/tmp/workspace',
    })

    expect(runCommandMock).toHaveBeenCalledWith({
      args: ['init'],
      bin: 'git',
      cwd: '/tmp/workspace',
      redactions: ['secret'],
      timeoutMs: 5_000,
    })
  })

  it('prepares artifacts, skips empty patches, and writes workspace metadata', async () => {
    const logger = createLogger()
    const workingDirectory = await createWorkspaceDirectory()
    runCommandMock
      .mockResolvedValueOnce('') // remote add origin
      .mockResolvedValueOnce('') // remote add head
      .mockResolvedValueOnce('') // checkout
      .mockResolvedValueOnce(
        ['M', 'src/app.ts', 'M', 'README.md', 'M', 'package-lock.json'].join('\0') +
          '\0',
      ) // name-status
      .mockResolvedValueOnce('@@ -1 +1 @@\n-old\n+new') // app patch
      .mockResolvedValueOnce('   ') // readme patch, skipped
      .mockResolvedValueOnce('export const value = "new"\n') // app content
      .mockResolvedValueOnce('diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@') // final diff

    const result = await prepareWorkspaceArtifacts({
      context: createContext(),
      logger: logger as never,
      options: undefined,
      prInfo: createPrInfo(),
      projectRoot: '/tmp/project-root',
      runtime: createRuntime(),
      workingDirectory,
    })

    expect(fetchRevisionMock).toHaveBeenCalledTimes(2)
    expect(runCommandMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        args: ['remote', 'add', 'origin', 'https://github.com/acme/base.git?token=secret'],
      }),
    )
    expect(runCommandMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        args: ['remote', 'add', 'head', 'https://github.com/acme/head.git?token=secret'],
      }),
    )
    expect(result.availableRevisionRefs).toEqual([
      'refs/codex-review/base',
      'refs/codex-review/head',
    ])
    expect(result.reviewableFiles).toEqual([
      {
        content: 'export const value = "new"\n',
        path: 'src/app.ts',
        patch: '@@ -1 +1 @@\n-old\n+new',
      },
    ])
    expect(result.diff).toContain('diff --git a/src/app.ts b/src/app.ts')

    const prInfoYaml = await readFile(
      path.join(workingDirectory, 'pr-info.yaml'),
      'utf8',
    )
    expect(prInfoYaml).toContain('owner: "acme"')
    expect(copyReviewSkillsToWorkspaceMock).toHaveBeenCalledWith({
      projectRoot: '/tmp/project-root',
      workingDirectory,
    })
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'workspace.artifacts_prepared',
        reviewableFileCount: 1,
        status: 'completed',
      }),
      'Workspace artifacts prepared',
    )
  })

  it('falls back cleanly when an additional revision fetch fails', async () => {
    const logger = createLogger()
    const workingDirectory = await createWorkspaceDirectory()
    fetchRevisionMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('cannot fetch previous'))
    runCommandMock
      .mockResolvedValueOnce('') // remote add origin
      .mockResolvedValueOnce('') // remote add head
      .mockResolvedValueOnce('') // checkout
      .mockResolvedValueOnce('') // name-status

    const result = await prepareWorkspaceArtifacts({
      context: createContext(),
      logger: logger as never,
      options: {
        additionalRevisions: [
          {
            fallbackRef: 'feature/ref',
            localRef: 'refs/codex-review/previous',
            remote: 'head',
            revision: 'previous-sha',
          },
        ],
      },
      prInfo: createPrInfo(),
      projectRoot: '/tmp/project-root',
      runtime: createRuntime(),
      workingDirectory,
    })

    expect(result.availableRevisionRefs).toEqual([
      'refs/codex-review/base',
      'refs/codex-review/head',
    ])
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'workspace.additional_revision_unavailable',
        localRef: 'refs/codex-review/previous',
        status: 'fallback',
      }),
      'Workspace additional revision unavailable',
    )
  })

  it('uses origin for head fetch when head and base remotes are the same and skips final diff when no files remain', async () => {
    const logger = createLogger()
    const workingDirectory = await createWorkspaceDirectory()
    runCommandMock
      .mockResolvedValueOnce('') // remote add origin
      .mockResolvedValueOnce('') // checkout
      .mockResolvedValueOnce(['M', 'package-lock.json'].join('\0') + '\0') // name-status

    const context = createContext({
      headCloneUrl: 'https://github.com/acme/repo.git',
      baseCloneUrl: 'https://github.com/acme/repo.git',
    })

    const result = await prepareWorkspaceArtifacts({
      context,
      logger: logger as never,
      options: undefined,
      prInfo: createPrInfo(),
      projectRoot: '/tmp/project-root',
      runtime: createRuntime(),
      workingDirectory,
    })

    expect(runCommandMock).toHaveBeenCalledTimes(3)
    expect(fetchRevisionMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        remote: 'origin',
      }),
    )
    expect(result.reviewableFiles).toEqual([])
    expect(result.diff).toBe('')
  })
})
