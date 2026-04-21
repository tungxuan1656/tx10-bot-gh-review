import type { AppLogger } from '../../types/app.js'
import type { PRInfoObject, PullRequestContext, ReviewableFile } from './core.js'

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

export type CreateTemporaryReviewWorkspaceManagerInput = {
  gitBin?: string
  githubToken: string
  logger: AppLogger
  timeoutMs?: number
}

export type ChangedFile = {
  path: string
  status: string
}

export type RunCommandInput = {
  args: string[]
  bin: string
  cwd: string
  env?: NodeJS.ProcessEnv
  redactions?: string[]
  timeoutMs: number
}
