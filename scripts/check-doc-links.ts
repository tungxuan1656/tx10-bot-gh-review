import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const markdownRoots = ['README.md', 'docs']

async function collectMarkdownFiles(target: string): Promise<string[]> {
  const resolved = path.resolve(target)
  const targetStat = await stat(resolved)

  if (targetStat.isFile()) {
    return resolved.endsWith('.md') ? [resolved] : []
  }

  const entries = await readdir(resolved, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(resolved, entry.name)
      if (entry.isDirectory()) {
        return collectMarkdownFiles(entryPath)
      }

      return entry.name.endsWith('.md') ? [entryPath] : []
    }),
  )

  return files.flat()
}

function isExternalLink(link: string): boolean {
  return (
    link.startsWith('http://') ||
    link.startsWith('https://') ||
    link.startsWith('mailto:') ||
    link.startsWith('#')
  )
}

async function validateLink(
  sourceFile: string,
  link: string,
): Promise<string | null> {
  if (isExternalLink(link)) {
    return null
  }

  const cleanLink = link.split('#')[0] ?? ''
  if (cleanLink.length === 0) {
    return null
  }

  const resolved = path.resolve(path.dirname(sourceFile), cleanLink)

  try {
    await stat(resolved)
    return null
  } catch {
    return `${path.relative(process.cwd(), sourceFile)} -> ${link}`
  }
}

async function main(): Promise<void> {
  const markdownFiles = (
    await Promise.all(markdownRoots.map(collectMarkdownFiles))
  ).flat()
  const failures: string[] = []

  for (const file of markdownFiles) {
    const content = await readFile(file, 'utf8')
    const matches = content.matchAll(/\[[^\]]+]\(([^)]+)\)/g)

    for (const match of matches) {
      const link = match[1]
      if (!link) {
        continue
      }

      const failure = await validateLink(file, link)
      if (failure) {
        failures.push(failure)
      }
    }
  }

  if (failures.length > 0) {
    console.error('Broken markdown links found:')
    for (const failure of failures) {
      console.error(`- ${failure}`)
    }
    process.exitCode = 1
    return
  }

  console.log(`Validated ${markdownFiles.length} markdown files.`)
}

void main()
