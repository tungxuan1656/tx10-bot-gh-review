import { z } from 'zod'

import type { CodexInspection } from './types.js'
import { shellQuotePath } from './prompt.js'
import { runCommand } from './workspace-git.js'

const eventSchema = z.object({ type: z.string(), item: z.unknown().optional() })
const commandSchema = z.object({
  type: z.literal('command_execution'),
  command: z.string(),
  status: z.literal('completed'),
  exit_code: z.literal(0),
  aggregated_output: z.string(),
})
const inspectionSchema = z.object({
  range: z.enum([
    'refs/codex-review/base...refs/codex-review/head',
    'refs/codex-review/previous..refs/codex-review/head',
  ]),
  paths: z.array(z.string().min(1)).min(1),
})

export function buildInspectionCommand(workingDirectory: string, inspection: CodexInspection): {
  command: string
  args: string[]
} {
  const scope = inspectionSchema.parse(inspection)
  const args = [
    '-C', workingDirectory, '--no-pager', 'diff', '--no-ext-diff', '--no-textconv',
    '--color=never', '--unified=5', scope.range, '--',
    ...scope.paths.map((filePath) => `:(literal)${filePath}`),
  ]
  const command = [
    'git', '-C', shellQuotePath(workingDirectory), '--no-pager', 'diff',
    '--no-ext-diff', '--no-textconv', '--color=never', '--unified=5',
    shellQuotePath(scope.range), '--',
    ...scope.paths.map((filePath) => shellQuotePath(`:(literal)${filePath}`)),
  ].join(' ')
  return { command, args }
}

function matchesInspectionCommand(actual: string, expected: string): boolean {
  if (actual === expected) return true
  // Codex JSONL serializes shell argv using POSIX quoting, not just the inner command.
  const doubleQuoted = '"' + expected.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`') + '"'
  const quotedCommands = [shellQuotePath(expected), `'${expected.replaceAll("'", `'"'"'`)}'`, doubleQuoted]
  return ['/bin/zsh', '/bin/bash', '/bin/sh', 'zsh', 'bash', 'sh'].some((shell) =>
    ['-lc', '-c'].some((flag) => quotedCommands.some((quoted) => actual === `${shell} ${flag} ${quoted}`)),
  )
}

export async function getCompletionFailure(input: {
  stdout: string
  workingDirectory: string
  inspection?: CodexInspection
  timeoutMs: number
}): Promise<string | null> {
  let events: z.infer<typeof eventSchema>[]
  try {
    events = input.stdout.split('\n').filter((line) => line.trim()).map((line) => {
      const parsed: unknown = JSON.parse(line)
      return eventSchema.parse(parsed)
    })
  } catch {
    return 'Codex emitted an invalid JSONL event stream.'
  }
  if (events.some((event) => event.type === 'turn.failed' || event.type === 'error')) {
    return 'Codex reported a failed turn or fatal runtime error.'
  }
  if (!events.some((event) => event.type === 'turn.completed')) {
    return 'Codex did not report a completed turn.'
  }
  if (!input.inspection) return null

  const required = buildInspectionCommand(input.workingDirectory, input.inspection)
  const completedCommands = events.flatMap((event) => {
    if (event.type !== 'item.completed') return []
    const parsed = commandSchema.safeParse(event.item)
    return parsed.success && matchesInspectionCommand(parsed.data.command, required.command)
      ? [parsed.data]
      : []
  })
  if (completedCommands.length === 0) {
    return 'Codex did not successfully execute the required diff inspection.'
  }

  // Independent read-only Git output detects truncated, wrong, or stale inspection results.
  let expectedOutput: string
  try {
    expectedOutput = await runCommand({
      bin: 'git', args: required.args, cwd: input.workingDirectory, timeoutMs: input.timeoutMs,
    })
  } catch {
    return 'Independent Git diff verification failed.'
  }
  if (!completedCommands.some((command) => command.aggregated_output.trimEnd() === expectedOutput.trimEnd())) {
    const truncatedCommand = completedCommands.find((command) => /\n\.\.\. \d+ bytes omitted \.\.\.\n/.test(command.aggregated_output))
    if (truncatedCommand) {
      return `Codex diff inspection output was truncated (expected ${Buffer.byteLength(expectedOutput, 'utf8')} bytes; received ${Buffer.byteLength(truncatedCommand.aggregated_output, 'utf8')} bytes, including the omission marker).`
    }
    return 'Codex diff inspection output did not match the complete required diff.'
  }
  return null
}
