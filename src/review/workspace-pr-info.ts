import type { PRInfoObject } from './types.js'

function escapeYamlString(value: string): string {
  if (value.includes('\n')) {
    const indented = value.replace(/\n/g, '\n  ')
    return `|-\n  ${indented}`
  }

  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function serializePRInfoToYaml(prInfo: PRInfoObject): string {
  const lines: string[] = [
    `owner: ${escapeYamlString(prInfo.owner)}`,
    `repo: ${escapeYamlString(prInfo.repo)}`,
    `pull_number: ${prInfo.pullNumber}`,
    `title: ${escapeYamlString(prInfo.title)}`,
    `html_url: ${escapeYamlString(prInfo.htmlUrl)}`,
    `head_sha: ${escapeYamlString(prInfo.headSha)}`,
    `base_sha: ${escapeYamlString(prInfo.baseSha)}`,
    `head_ref: ${escapeYamlString(prInfo.headRef)}`,
    `base_ref: ${escapeYamlString(prInfo.baseRef)}`,
    `description: ${escapeYamlString(prInfo.description || '(none)')}`,
    '',
    'commits:',
  ]

  for (const commit of prInfo.commits) {
    lines.push(`  - sha: ${escapeYamlString(commit.sha)}`)
    lines.push(`    message: ${escapeYamlString(commit.message)}`)
  }

  lines.push('')
  lines.push('changed_files:')
  for (const filePath of prInfo.changedFilePaths) {
    lines.push(`  - ${escapeYamlString(filePath)}`)
  }

  return lines.join('\n') + '\n'
}
