import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import type { AppLogger } from '../types/app.js'
import {
  codexOutputJsonSchema,
  detectFailureHint,
  stripJsonFences,
  summarizeOutput,
  summarizeOutputTail,
} from './codex-output.js'

export type CodexPhaseResult =
  | { ok: true; output: string }
  | { ok: false; reason: string; cancelled?: boolean }

export async function runCodexPhase(input: {
  abortSignal: AbortSignal | undefined
  bin: string
  logger: AppLogger
  model: string | undefined
  phaseLabel: string
  prompt: string
  timeoutMs: number
  validateJson: boolean
  workingDirectory: string
}): Promise<CodexPhaseResult> {
  if (input.abortSignal?.aborted) {
    return { ok: false, reason: 'Codex review canceled.', cancelled: true }
  }

  const startedAt = Date.now()
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-review-'))

  try {
    const outputPath = path.join(tempDirectory, 'result.json')
    const outputSchemaPath = path.join(tempDirectory, 'codex-output-schema.json')

    if (input.validateJson) {
      await writeFile(
        outputSchemaPath,
        JSON.stringify(codexOutputJsonSchema, null, 2),
        'utf8',
      )
    }

    const args = [
      'exec',
      '--cd',
      input.workingDirectory,
      ...(input.model ? ['--model', input.model] : []),
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      ...(input.validateJson ? ['--output-schema', outputSchemaPath] : []),
      '--output-last-message',
      outputPath,
      '-',
    ]

    input.logger.debug(
      {
        component: 'codex',
        event: 'codex.phase_started',
        phase: input.phaseLabel,
        promptChars: input.prompt.length,
        status: 'started',
        validateJson: input.validateJson,
        model: input.model,
        workingDirectory: input.workingDirectory,
      },
      'Codex phase started',
    )

    const child = spawn(input.bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let cancelled = false
    let abortListener: (() => void) | undefined
    let stdinWriteError: unknown

    const killChildProcess = () => {
      if (child.exitCode !== null) return
      cancelled = true
      child.kill('SIGTERM')
      const forceKillTimeout = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, 2_000)
      forceKillTimeout.unref()
    }

    if (input.abortSignal) {
      abortListener = () => killChildProcess()
      input.abortSignal.addEventListener('abort', abortListener, { once: true })
      if (input.abortSignal.aborted) killChildProcess()
    }

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.stdin.on('error', (error: unknown) => {
      stdinWriteError = error
    })
    try {
      child.stdin.end(input.prompt)
    } catch (error) {
      stdinWriteError = error
    }

    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      killChildProcess()
    }, input.timeoutMs)

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    }).finally(() => {
      clearTimeout(timeout)
      if (input.abortSignal && abortListener) {
        input.abortSignal.removeEventListener('abort', abortListener)
      }
    })

    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
    const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()

    if (stdinWriteError && !timedOut && !cancelled) {
      const message =
        stdinWriteError instanceof Error
          ? stdinWriteError.message
          : typeof stdinWriteError === 'string'
            ? stdinWriteError
            : (() => {
                try {
                  return JSON.stringify(stdinWriteError) ?? 'Unknown stdin write error'
                } catch {
                  return 'Unknown stdin write error'
                }
              })()

      input.logger.warn(
        {
          component: 'codex',
          durationMs: Date.now() - startedAt,
          event: 'codex.stdin_write_failed',
          phase: input.phaseLabel,
          reason: 'stdin_write_failed',
          message,
          status: 'failed',
        },
        'Codex stdin write failed',
      )
    }

    if (timedOut) {
      input.logger.error(
        {
          component: 'codex',
          durationMs: Date.now() - startedAt,
          event: 'codex.failed',
          phase: input.phaseLabel,
          reason: 'timeout',
          stderrPreview: summarizeOutput(stderr),
          stdoutPreview: summarizeOutput(stdout),
          stderrBytes: Buffer.byteLength(stderr, 'utf8'),
          stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
          status: 'failed',
          timeoutMs: input.timeoutMs,
        },
        'Codex review failed',
      )
      return { ok: false, reason: `Codex timed out after ${input.timeoutMs}ms.` }
    }

    if (cancelled) {
      input.logger.info(
        {
          component: 'codex',
          durationMs: Date.now() - startedAt,
          event: 'codex.canceled',
          phase: input.phaseLabel,
          status: 'canceled',
        },
        'Codex review canceled',
      )
      return { ok: false, reason: 'Codex review canceled.', cancelled: true }
    }

    if (exitCode !== 0) {
      const failureHint = detectFailureHint(stderr)

      input.logger.warn(
        {
          component: 'codex',
          event: 'codex.failed',
          exitCode,
          durationMs: Date.now() - startedAt,
          failureHint,
          phase: input.phaseLabel,
          promptChars: input.prompt.length,
          reason: 'non_zero_exit',
          stderrPreview: summarizeOutput(stderr),
          stderrTailPreview: summarizeOutputTail(stderr),
          stdoutPreview: summarizeOutput(stdout),
          stdoutTailPreview: summarizeOutputTail(stdout),
          stderrBytes: Buffer.byteLength(stderr, 'utf8'),
          stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
          status: 'failed',
        },
        'Codex review failed',
      )
      return { ok: false, reason: 'Codex returned a non-zero exit code.' }
    }

    const rawOutput = stripJsonFences(
      await readFile(outputPath, 'utf8').catch(() => stdout),
    )

    input.logger.info(
      {
        component: 'codex',
        durationMs: Date.now() - startedAt,
        event: 'codex.phase_completed',
        outputChars: rawOutput.length,
        phase: input.phaseLabel,
        status: 'completed',
      },
      'Codex phase completed',
    )

    return { ok: true, output: rawOutput }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
}
