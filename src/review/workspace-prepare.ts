import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { AppLogger } from '../types/app.js'
import type {
  PRInfoObject,
  PreparedReviewWorkspace,
  PullRequestContext,
  ReviewableFile,
  WorkspacePrepareOptions,
} from './types.js'
import {
  buildAuthenticatedRemoteUrl,
  fetchRevision,
  runCommand,
} from './workspace-git.js'
import {
  isReviewableChangedFile,
  maxDiffChars,
  parseChangedFiles,
  truncateDiff,
} from './workspace-files.js'
import { serializePRInfoToYaml } from './workspace-pr-info.js'
import { copyReviewSkillsToWorkspace } from './workspace-review-skills.js'

const baseRefName = 'refs/codex-review/base'
const headRefName = 'refs/codex-review/head'

type WorkspaceRuntimeContext = {
  gitBin: string
  timeoutMs: number
  commandRedactions: string[]
  githubToken: string
}

type InitializedWorkspace = {
  availableRevisionRefs: string[]
  headRefName: string
}

async function initRepository(input: {
  runtime: WorkspaceRuntimeContext
  workingDirectory: string
}): Promise<void> {
  await runCommand({
    args: ['init'],
    bin: input.runtime.gitBin,
    cwd: input.workingDirectory,
    redactions: input.runtime.commandRedactions,
    timeoutMs: input.runtime.timeoutMs,
  })
}

async function configureRemotesAndFetchRefs(input: {
  context: PullRequestContext
  logger: AppLogger
  options: WorkspacePrepareOptions | undefined
  runtime: WorkspaceRuntimeContext
  workingDirectory: string
}): Promise<InitializedWorkspace> {
  const baseRemoteUrl = buildAuthenticatedRemoteUrl(
    input.context.baseCloneUrl,
    input.runtime.githubToken,
  )
  const headRemoteUrl = buildAuthenticatedRemoteUrl(
    input.context.headCloneUrl,
    input.runtime.githubToken,
  )

  await runCommand({
    args: ['remote', 'add', 'origin', baseRemoteUrl],
    bin: input.runtime.gitBin,
    cwd: input.workingDirectory,
    redactions: input.runtime.commandRedactions,
    timeoutMs: input.runtime.timeoutMs,
  })

  const headRemoteName = headRemoteUrl === baseRemoteUrl ? 'origin' : 'head'
  if (headRemoteName === 'head') {
    await runCommand({
      args: ['remote', 'add', 'head', headRemoteUrl],
      bin: input.runtime.gitBin,
      cwd: input.workingDirectory,
      redactions: input.runtime.commandRedactions,
      timeoutMs: input.runtime.timeoutMs,
    })
  }

  await fetchRevision({
    cwd: input.workingDirectory,
    fallbackRef: input.context.baseRef,
    gitBin: input.runtime.gitBin,
    localRef: baseRefName,
    remote: 'origin',
    redactions: input.runtime.commandRedactions,
    revision: input.context.baseSha,
    timeoutMs: input.runtime.timeoutMs,
  })

  await fetchRevision({
    cwd: input.workingDirectory,
    fallbackRef: input.context.headRef,
    gitBin: input.runtime.gitBin,
    localRef: headRefName,
    remote: headRemoteName,
    redactions: input.runtime.commandRedactions,
    revision: input.context.headSha,
    timeoutMs: input.runtime.timeoutMs,
  })

  const availableRevisionRefs = [baseRefName, headRefName]
  for (const revision of input.options?.additionalRevisions ?? []) {
    try {
      await fetchRevision({
        cwd: input.workingDirectory,
        fallbackRef: revision.fallbackRef,
        gitBin: input.runtime.gitBin,
        localRef: revision.localRef,
        remote: revision.remote === 'origin' ? 'origin' : headRemoteName,
        redactions: input.runtime.commandRedactions,
        revision: revision.revision,
        timeoutMs: input.runtime.timeoutMs,
      })
      availableRevisionRefs.push(revision.localRef)
    } catch (error) {
      input.logger.warn(
        {
          component: 'workspace',
          error,
          event: 'workspace.additional_revision_unavailable',
          fallbackRef: revision.fallbackRef,
          localRef: revision.localRef,
          revision: revision.revision,
          status: 'fallback',
        },
        'Workspace additional revision unavailable',
      )
    }
  }

  await runCommand({
    args: ['checkout', '--detach', headRefName],
    bin: input.runtime.gitBin,
    cwd: input.workingDirectory,
    redactions: input.runtime.commandRedactions,
    timeoutMs: input.runtime.timeoutMs,
  })

  return {
    availableRevisionRefs,
    headRefName,
  }
}

async function writeWorkspaceMetadata(input: {
  prInfo: PRInfoObject
  projectRoot: string
  workingDirectory: string
}): Promise<void> {
  await copyReviewSkillsToWorkspace({
    projectRoot: input.projectRoot,
    workingDirectory: input.workingDirectory,
  })

  await writeFile(
    path.join(input.workingDirectory, 'pr-info.yaml'),
    serializePRInfoToYaml(input.prInfo),
    'utf8',
  )
}

async function collectReviewableFiles(input: {
  runtime: WorkspaceRuntimeContext
  workingDirectory: string
}): Promise<ReviewableFile[]> {
  const changedFiles = parseChangedFiles(
    await runCommand({
      args: ['diff', '--name-status', '-z', baseRefName, headRefName],
      bin: input.runtime.gitBin,
      cwd: input.workingDirectory,
      redactions: input.runtime.commandRedactions,
      timeoutMs: input.runtime.timeoutMs,
    }),
  ).filter(isReviewableChangedFile)

  return (
    await Promise.all(
      changedFiles.map(async (file) => {
        const patch = await runCommand({
          args: ['diff', '--unified=5', baseRefName, headRefName, '--', file.path],
          bin: input.runtime.gitBin,
          cwd: input.workingDirectory,
          redactions: input.runtime.commandRedactions,
          timeoutMs: input.runtime.timeoutMs,
        })

        if (!patch.trim()) {
          return null
        }

        const content = await runCommand({
          args: ['show', `${headRefName}:${file.path}`],
          bin: input.runtime.gitBin,
          cwd: input.workingDirectory,
          redactions: input.runtime.commandRedactions,
          timeoutMs: input.runtime.timeoutMs,
        })

        return {
          content,
          path: file.path,
          patch,
        } satisfies ReviewableFile
      }),
    )
  ).filter((file): file is ReviewableFile => file !== null)
}

async function buildWorkspaceDiff(input: {
  reviewableFiles: ReviewableFile[]
  runtime: WorkspaceRuntimeContext
  workingDirectory: string
}): Promise<{
  diff: string
  diffTruncated: boolean
}> {
  const rawDiff =
    input.reviewableFiles.length === 0
      ? ''
      : await runCommand({
          args: [
            'diff',
            '--unified=5',
            baseRefName,
            headRefName,
            '--',
            ...input.reviewableFiles.map((file) => file.path),
          ],
          bin: input.runtime.gitBin,
          cwd: input.workingDirectory,
          redactions: input.runtime.commandRedactions,
          timeoutMs: input.runtime.timeoutMs,
        })

  return {
    diff: truncateDiff(rawDiff),
    diffTruncated: rawDiff.length > maxDiffChars,
  }
}

export async function prepareWorkspaceArtifacts(input: {
  context: PullRequestContext
  logger: AppLogger
  options: WorkspacePrepareOptions | undefined
  prInfo: PRInfoObject
  projectRoot: string
  runtime: WorkspaceRuntimeContext
  workingDirectory: string
}): Promise<Pick<PreparedReviewWorkspace, 'availableRevisionRefs' | 'diff' | 'reviewableFiles'>> {
  const initializedWorkspace = await configureRemotesAndFetchRefs({
    context: input.context,
    logger: input.logger,
    options: input.options,
    runtime: input.runtime,
    workingDirectory: input.workingDirectory,
  })

  await writeWorkspaceMetadata({
    prInfo: input.prInfo,
    projectRoot: input.projectRoot,
    workingDirectory: input.workingDirectory,
  })

  const reviewableFiles = await collectReviewableFiles({
    runtime: input.runtime,
    workingDirectory: input.workingDirectory,
  })

  const { diff, diffTruncated } = await buildWorkspaceDiff({
    reviewableFiles,
    runtime: input.runtime,
    workingDirectory: input.workingDirectory,
  })

  input.logger.info(
    {
      component: 'workspace',
      diffChars: diff.length,
      diffTruncated,
      event: 'workspace.artifacts_prepared',
      reviewableFileCount: reviewableFiles.length,
      status: 'completed',
    },
    'Workspace artifacts prepared',
  )

  return {
    availableRevisionRefs: initializedWorkspace.availableRevisionRefs,
    diff,
    reviewableFiles,
  }
}

export async function prepareWorkspaceRepository(input: {
  runtime: WorkspaceRuntimeContext
  workingDirectory: string
}): Promise<void> {
  await initRepository(input)
}
