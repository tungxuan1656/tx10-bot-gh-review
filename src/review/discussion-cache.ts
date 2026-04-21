import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { AppLogger } from '../logger.js'
import type { PullRequestContext } from './types.js'

export const reviewCommentsFileName = 'pr-review-comments.md'
const defaultDiscussionCacheDirectory = path.join(
  os.tmpdir(),
  'tx10-review-discussions',
)
const defaultDiscussionCacheTtlMs = 7 * 24 * 60 * 60 * 1_000

export type DiscussionCacheOptions = {
  discussionCacheDirectory?: string
  discussionCacheTtlMs?: number
}

function getDiscussionCacheDirectory(
  options: DiscussionCacheOptions,
): string {
  return options.discussionCacheDirectory ?? defaultDiscussionCacheDirectory
}

function getDiscussionCacheTtlMs(options: DiscussionCacheOptions): number {
  return options.discussionCacheTtlMs ?? defaultDiscussionCacheTtlMs
}

async function cleanupExpiredDiscussionSnapshots(input: {
  discussionCacheDirectory: string
  discussionCacheTtlMs: number
  runLogger: AppLogger
}): Promise<void> {
  const expirationThreshold = Date.now() - input.discussionCacheTtlMs

  const pullRequestDirectories = await readdir(input.discussionCacheDirectory, {
    encoding: 'utf8',
    withFileTypes: true,
  }).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return null
    }

    input.runLogger.warn(
      {
        error,
        event: 'review.discussion_context_cleanup_failed',
        reason: 'list_directory_failed',
        status: 'failed',
      },
      'Review discussion context cleanup failed',
    )
    return null
  })

  if (!pullRequestDirectories) {
    return
  }

  for (const entry of pullRequestDirectories) {
    if (!entry.isDirectory()) {
      continue
    }

    const pullRequestDirectoryPath = path.join(
      input.discussionCacheDirectory,
      entry.name,
    )
    const files = await readdir(pullRequestDirectoryPath, {
      encoding: 'utf8',
      withFileTypes: true,
    }).catch(() => [])

    for (const file of files) {
      if (!file.isFile()) {
        continue
      }

      const filePath = path.join(pullRequestDirectoryPath, file.name)
      const fileStats = await stat(filePath).catch(() => null)
      if (!fileStats || fileStats.mtimeMs > expirationThreshold) {
        continue
      }

      await rm(filePath, { force: true }).catch(() => undefined)
    }

    const remainingFiles = await readdir(pullRequestDirectoryPath, {
      encoding: 'utf8',
      withFileTypes: true,
    }).catch(() => [])
    if (remainingFiles.length === 0) {
      await rm(pullRequestDirectoryPath, {
        force: true,
        recursive: true,
      }).catch(() => undefined)
    }
  }
}

export async function persistDiscussionContext(input: {
  context: PullRequestContext
  discussionMarkdown: string
  runLogger: AppLogger
  workingDirectory: string
  options?: DiscussionCacheOptions
}): Promise<void> {
  const discussionCacheDirectory = getDiscussionCacheDirectory(
    input.options ?? {},
  )
  const discussionCacheTtlMs = getDiscussionCacheTtlMs(input.options ?? {})

  await mkdir(discussionCacheDirectory, { recursive: true })
  await cleanupExpiredDiscussionSnapshots({
    discussionCacheDirectory,
    discussionCacheTtlMs,
    runLogger: input.runLogger,
  })
  await mkdir(input.workingDirectory, { recursive: true })

  const pullRequestDirectoryName = `${input.context.owner}__${input.context.repo}__pr-${input.context.pullNumber}`
  const pullRequestDirectoryPath = path.join(
    discussionCacheDirectory,
    pullRequestDirectoryName,
  )
  await mkdir(pullRequestDirectoryPath, { recursive: true })

  const cacheSnapshotPath = path.join(
    pullRequestDirectoryPath,
    `${input.context.headSha}.md`,
  )
  const workspaceDiscussionPath = path.join(
    input.workingDirectory,
    reviewCommentsFileName,
  )

  await writeFile(cacheSnapshotPath, input.discussionMarkdown, 'utf8')
  await writeFile(workspaceDiscussionPath, input.discussionMarkdown, 'utf8')

  input.runLogger.info(
    {
      cacheSnapshotPath,
      discussionFile: reviewCommentsFileName,
      event: 'review.discussion_context_saved',
      status: 'completed',
    },
    'Review discussion context saved',
  )
}
