import {
  mkdtemp,
  rm,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AppLogger } from '../types/app.js'
import type {
  CreateTemporaryReviewWorkspaceManagerInput,
  PRInfoObject,
  PullRequestContext,
  ReviewWorkspaceManager,
  WorkspacePrepareOptions,
  PreparedReviewWorkspace,
} from './types.js'
import { resolveProjectRootFrom } from './workspace-review-skills.js'
import {
  prepareWorkspaceArtifacts,
  prepareWorkspaceRepository,
} from './workspace-prepare.js'

export type {
  AdditionalWorkspaceRevision,
  PreparedReviewWorkspace,
  ReviewWorkspaceManager,
  WorkspacePrepareOptions,
} from './types.js'

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
      const projectRoot = await resolveProjectRootFrom(currentFilePath)

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

        await prepareWorkspaceRepository({
          runtime: {
            commandRedactions,
            gitBin,
            githubToken: input.githubToken,
            timeoutMs,
          },
          workingDirectory,
        })

        const { availableRevisionRefs, diff, reviewableFiles } =
          await prepareWorkspaceArtifacts({
            context,
            logger,
            options,
            prInfo,
            projectRoot,
            runtime: {
              commandRedactions,
              gitBin,
              githubToken: input.githubToken,
              timeoutMs,
            },
            workingDirectory,
          })

        logger.info(
          {
            component: 'workspace',
            diffChars: diff.length,
            diffTruncated: diff.length > 0 && diff.includes('...[diff truncated]'),
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
