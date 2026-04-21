import { isReviewableFilePath } from './filter-files.js'

export const maxDiffChars = 80_000

export type ChangedFile = {
  path: string
  status: string
}

function isRenameOrCopy(status: string): boolean {
  return status.startsWith('R') || status.startsWith('C')
}

function isRemovedStatus(status: string): boolean {
  return status.startsWith('D')
}

export function parseChangedFiles(rawOutput: string): ChangedFile[] {
  const entries = rawOutput.split('\0').filter((entry) => entry.length > 0)
  const changedFiles: ChangedFile[] = []

  for (let index = 0; index < entries.length; index += 1) {
    const status = entries[index]

    if (!status) {
      continue
    }

    if (isRenameOrCopy(status)) {
      const nextPath = entries[index + 2]
      if (nextPath) {
        changedFiles.push({
          path: nextPath,
          status,
        })
      }
      index += 2
      continue
    }

    const nextPath = entries[index + 1]
    if (nextPath) {
      changedFiles.push({
        path: nextPath,
        status,
      })
    }
    index += 1
  }

  return changedFiles
}

export function isReviewableChangedFile(file: ChangedFile): boolean {
  return !isRemovedStatus(file.status) && isReviewableFilePath(file.path)
}

export function truncateDiff(diff: string): string {
  if (diff.length <= maxDiffChars) {
    return diff
  }

  return `${diff.slice(0, maxDiffChars)}\n...[diff truncated]`
}
