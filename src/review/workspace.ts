import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AppLogger } from '../logger.js'
import type {
  PRInfoObject,
  PullRequestContext,
  ReviewableFile,
} from './types.js'
import {
  fetchRevision,
  buildAuthenticatedRemoteUrl,
  runCommand,
} from './workspace-git.js'
import {
  isReviewableChangedFile,
  maxDiffChars,
  parseChangedFiles,
  truncateDiff,
} from './workspace-files.js'
import { serializePRInfoToYaml } from './workspace-pr-info.js'
import {
  copyReviewSkillsToWorkspace,
  resolveProjectRootFrom,
} from './workspace-review-skills.js'

const baseRefName = 'refs/codex-review/base'
const headRefName = 'refs/codex-review/head'

export type PreparedReviewWorkspace = {
  availableRevisionRefs: string[]
  cleanup(): Promise<void>
  diff: string
  prInfo: PRInfoObject
  reviewableFiles: ReviewableFile[]
  workingDirectory: string
}

export type AdditionalWorkspaceRevision = {
  revision: string
  fallbackRef: string
  localRef: string
  remote?: 'origin' | 'head'
}

export type WorkspacePrepareOptions = {
  additionalRevisions?: AdditionalWorkspaceRevision[]
}

export type ReviewWorkspaceManager = {
  prepareWorkspace(
    context: PullRequestContext,
    prInfo: PRInfoObject,
    loggerOverride?: AppLogger,
    options?: WorkspacePrepareOptions,
  ): Promise<PreparedReviewWorkspace>
}

type CreateTemporaryReviewWorkspaceManagerInput = {
  gitBin?: string
  githubToken: string
  logger: AppLogger
  timeoutMs?: number
}

const currentFilePath = fileURLToPath(import.meta.url)

function createWorkspaceCleanup(workingDirectory: string): () => Promise<void> {
  let cleanedUp = false

  return async () => {
    if (cleanedUp) {
      return
    }

    cleanedUp = true
    await rm(workingDirectory, { force: true, recursive: true })
  }
}

export function createTemporaryReviewWorkspaceManager(
  input: CreateTemporaryReviewWorkspaceManagerInput,
): ReviewWorkspaceManager {
  const gitBin = input.gitBin ?? 'git'
  const timeoutMs = input.timeoutMs ?? 60_000
  const commandRedactions = [
    input.githubToken,
    encodeURIComponent(input.githubToken),
  ]

  return {
    async prepareWorkspace(
      context: PullRequestContext,
      prInfo: PRInfoObject,
      loggerOverride?: AppLogger,
      options?: WorkspacePrepareOptions,
    ): Promise<PreparedReviewWorkspace> {
      const logger = loggerOverride ?? input.logger
      const startedAt = Date.now()
      const workingDirectory = await mkdtemp(
        path.join(os.tmpdir(), 'codex-review-workspace-'),
      )
      const cleanup = createWorkspaceCleanup(workingDirectory)

      try {
        logger.info(
          {
            component: 'workspace',
            event: 'workspace.prepare_started',
            headSha: context.headSha,
            status: 'started',
          },
          'Workspace prepare started',
        )

        await runCommand({
          args: ['init'],
          bin: gitBin,
          cwd: workingDirectory,
          redactions: commandRedactions,
          timeoutMs,
        })

        const baseRemoteUrl = buildAuthenticatedRemoteUrl(
          context.baseCloneUrl,
          input.githubToken,
        )
        const headRemoteUrl = buildAuthenticatedRemoteUrl(
          context.headCloneUrl,
          input.githubToken,
        )

        await runCommand({
          args: ['remote', 'add', 'origin', baseRemoteUrl],
          bin: gitBin,
          cwd: workingDirectory,
          redactions: commandRedactions,
          timeoutMs,
        })

        const headRemoteName =
          headRemoteUrl === baseRemoteUrl ? 'origin' : 'head'
        if (headRemoteName === 'head') {
          await runCommand({
            args: ['remote', 'add', 'head', headRemoteUrl],
            bin: gitBin,
            cwd: workingDirectory,
            redactions: commandRedactions,
            timeoutMs,
          })
        }

        await fetchRevision({
          cwd: workingDirectory,
          fallbackRef: context.baseRef,
          gitBin,
          localRef: baseRefName,
          remote: 'origin',
          redactions: commandRedactions,
          revision: context.baseSha,
          timeoutMs,
        })
        await fetchRevision({
          cwd: workingDirectory,
          fallbackRef: context.headRef,
          gitBin,
          localRef: headRefName,
          remote: headRemoteName,
          redactions: commandRedactions,
          revision: context.headSha,
          timeoutMs,
        })

        const availableRevisionRefs = [baseRefName, headRefName]
        for (const revision of options?.additionalRevisions ?? []) {
          try {
            await fetchRevision({
              cwd: workingDirectory,
              fallbackRef: revision.fallbackRef,
              gitBin,
              localRef: revision.localRef,
              remote:
                revision.remote === 'origin' ? 'origin' : headRemoteName,
              redactions: commandRedactions,
              revision: revision.revision,
              timeoutMs,
            })
            availableRevisionRefs.push(revision.localRef)
          } catch (error) {
            logger.warn(
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
          bin: gitBin,
          cwd: workingDirectory,
          redactions: commandRedactions,
          timeoutMs,
        })

        await copyReviewSkillsToWorkspace({
          projectRoot: await resolveProjectRootFrom(currentFilePath),
          workingDirectory,
        })

        // Write pr-info.yaml into workspace root for Codex to read
        const prInfoYaml = serializePRInfoToYaml(prInfo)
        await writeFile(
          path.join(workingDirectory, 'pr-info.yaml'),
          prInfoYaml,
          'utf8',
        )

        const changedFiles = parseChangedFiles(
          await runCommand({
            args: ['diff', '--name-status', '-z', baseRefName, headRefName],
            bin: gitBin,
            cwd: workingDirectory,
            redactions: commandRedactions,
            timeoutMs,
          }),
        ).filter(isReviewableChangedFile)

        const reviewableFiles = (
          await Promise.all(
            changedFiles.map(async (file) => {
              const patch = await runCommand({
                args: [
                  'diff',
                  '--unified=5',
                  baseRefName,
                  headRefName,
                  '--',
                  file.path,
                ],
                bin: gitBin,
                cwd: workingDirectory,
                redactions: commandRedactions,
                timeoutMs,
              })

              if (!patch.trim()) {
                return null
              }

              const content = await runCommand({
                args: ['show', `${headRefName}:${file.path}`],
                bin: gitBin,
                cwd: workingDirectory,
                redactions: commandRedactions,
                timeoutMs,
              })

              return {
                content,
                path: file.path,
                patch,
              } satisfies ReviewableFile
            }),
          )
        ).filter((file): file is ReviewableFile => file !== null)

        const rawDiff =
          reviewableFiles.length === 0
            ? ''
            : await runCommand({
                args: [
                  'diff',
                  '--unified=5',
                  baseRefName,
                  headRefName,
                  '--',
                  ...reviewableFiles.map((file) => file.path),
                ],
                bin: gitBin,
                cwd: workingDirectory,
                redactions: commandRedactions,
                timeoutMs,
              })

        const diff = truncateDiff(rawDiff)

        logger.info(
          {
            component: 'workspace',
            diffChars: diff.length,
            diffTruncated: rawDiff.length > maxDiffChars,
            durationMs: Date.now() - startedAt,
            event: 'workspace.prepare_completed',
            reviewableFileCount: reviewableFiles.length,
            status: 'completed',
          },
          'Workspace prepare completed',
        )

        return {
          availableRevisionRefs,
          cleanup,
          diff,
          prInfo,
          reviewableFiles,
          workingDirectory,
        }
      } catch (error) {
        logger.error(
          {
            component: 'workspace',
            error,
            event: 'workspace.prepare_failed',
            status: 'failed',
          },
          'Workspace prepare failed',
        )
        await cleanup()
        throw error
      }
    },
  }
}
