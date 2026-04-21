import {
  access,
  cp,
  mkdir,
  readdir,
} from 'node:fs/promises'
import path from 'node:path'

const reviewSkillsRelativePath = path.join('resources', 'review-skills')

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

export async function resolveProjectRootFrom(startPath: string): Promise<string> {
  let currentPath = path.dirname(startPath)

  while (true) {
    if (await pathExists(path.join(currentPath, reviewSkillsRelativePath))) {
      return currentPath
    }

    const parentPath = path.dirname(currentPath)
    if (parentPath === currentPath) {
      throw new Error(
        `Could not resolve project root containing ${reviewSkillsRelativePath} from ${startPath}.`,
      )
    }

    currentPath = parentPath
  }
}

export async function copyReviewSkillsToWorkspace(input: {
  projectRoot: string
  workingDirectory: string
}): Promise<void> {
  const sourceSkillsDirectory = path.join(
    input.projectRoot,
    reviewSkillsRelativePath,
  )
  const destinationSkillsDirectory = path.join(
    input.workingDirectory,
    '.agents',
    'skills',
  )
  const skillEntries = await readdir(sourceSkillsDirectory, {
    withFileTypes: true,
  })

  await mkdir(destinationSkillsDirectory, { recursive: true })

  await Promise.all(
    skillEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        cp(
          path.join(sourceSkillsDirectory, entry.name),
          path.join(destinationSkillsDirectory, entry.name),
          {
            force: true,
            recursive: true,
          },
        ),
      ),
  )
}
