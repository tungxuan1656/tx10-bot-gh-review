import { spawn } from 'node:child_process'

export type RunCommandInput = {
  args: string[]
  bin: string
  cwd: string
  env?: NodeJS.ProcessEnv
  redactions?: string[]
  timeoutMs: number
}

export function buildAuthenticatedRemoteUrl(
  cloneUrl: string,
  githubToken: string,
): string {
  if (!/^https?:\/\//.test(cloneUrl)) {
    return cloneUrl
  }

  const url = new URL(cloneUrl)
  url.username = 'x-access-token'
  url.password = githubToken
  return url.toString()
}

export function redactCommandOutput(text: string, redactions: string[]): string {
  let sanitized = text

  for (const redaction of redactions) {
    if (!redaction) {
      continue
    }

    sanitized = sanitized.split(redaction).join('***')
  }

  return sanitized.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@')
}

export async function runCommand(input: RunCommandInput): Promise<string> {
  const child = spawn(input.bin, input.args, {
    cwd: input.cwd,
    env: {
      ...process.env,
      ...input.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutChunks.push(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk)
  })

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
  }, input.timeoutMs)

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }).finally(() => {
    clearTimeout(timeout)
  })

  const stdout = Buffer.concat(stdoutChunks).toString('utf8')
  const stderr = redactCommandOutput(
    Buffer.concat(stderrChunks).toString('utf8').trim(),
    input.redactions ?? [],
  )
  const commandLabel = `${input.bin} ${input.args[0] ?? ''}`.trim()

  if (timedOut) {
    throw new Error(`Command timed out: ${commandLabel}`)
  }

  if (exitCode !== 0) {
    throw new Error(stderr || `Command failed: ${commandLabel}`)
  }

  return stdout
}

export async function fetchRevision(input: {
  cwd: string
  gitBin: string
  remote: string
  revision: string
  fallbackRef: string
  localRef: string
  redactions: string[]
  timeoutMs: number
}): Promise<void> {
  const env = {
    GIT_TERMINAL_PROMPT: '0',
  }

  try {
    await runCommand({
      args: [
        'fetch',
        '--no-tags',
        '--depth=1',
        input.remote,
        `+${input.revision}:${input.localRef}`,
      ],
      bin: input.gitBin,
      cwd: input.cwd,
      env,
      redactions: input.redactions,
      timeoutMs: input.timeoutMs,
    })
  } catch {
    await runCommand({
      args: [
        'fetch',
        '--no-tags',
        input.remote,
        `+refs/heads/${input.fallbackRef}:${input.localRef}`,
      ],
      bin: input.gitBin,
      cwd: input.cwd,
      env,
      redactions: input.redactions,
      timeoutMs: input.timeoutMs,
    })
  }

  const resolvedRevision = (
    await runCommand({
      args: ['rev-parse', input.localRef],
      bin: input.gitBin,
      cwd: input.cwd,
      redactions: input.redactions,
      timeoutMs: input.timeoutMs,
    })
  ).trim()

  if (resolvedRevision !== input.revision) {
    throw new Error(
      `Fetched ${input.localRef} at ${resolvedRevision}, expected ${input.revision}.`,
    )
  }
}
