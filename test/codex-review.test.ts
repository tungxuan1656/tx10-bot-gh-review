import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'

import {
  cleanupCodexTestArtifacts,
  createAbortAwareFakeCodexBinary,
  createFailingFakeCodexBinary,
  createFakeCodexBinary,
  createRunner,
  createSchemaOutputFakeCodexBinary,
  createSlowFakeCodexBinary,
  readJsonFile,
} from './codex-test-helpers.js'

afterEach(async () => {
  await cleanupCodexTestArtifacts()
})

describe('createCodexRunner review', () => {
  it('defaults to a 15 minute timeout budget', async () => {
    const { binPath, capturePath } = await createFakeCodexBinary()
    process.env.TEST_CAPTURE_PATH = capturePath
    const { logger, runner } = createRunner({
      bin: binPath,
    })

    await runner.review({
      prompt: 'Review this diff',
      workingDirectory: '/tmp/pr-workspace',
    })

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'codex.started',
        timeoutMs: 900_000,
      }),
      'Codex review started',
    )
  })

  it('passes workspace, sandbox, and output schema to codex exec', async () => {
    const { binPath, capturePath } = await createFakeCodexBinary()
    process.env.TEST_CAPTURE_PATH = capturePath
    const { runner } = createRunner({
      bin: binPath,
      timeoutMs: 5_000,
    })

    const outcome = await runner.review({
      prompt: 'Review this diff',
      workingDirectory: '/tmp/pr-workspace',
    })

    expect(outcome).toEqual({
      ok: true,
      result: {
        summary: 'ok',
        changesOverview: '',
        score: 9,
        decision: 'approve',
        findings: [],
      },
    })

    const capture = await readJsonFile<{
      args: string[]
      cwd: string
      stdin: string
      outputSchema: {
        properties: Record<string, unknown>
        required: string[]
      } | null
    }>(capturePath)

    expect(capture.args).toContain('exec')
    expect(capture.args).toContain('--cd')
    expect(capture.args).toContain('/tmp/pr-workspace')
    expect(capture.args).toContain('--sandbox')
    expect(capture.args).toContain('workspace-write')
    expect(capture.args).toContain('--output-schema')
    expect(capture.args).toContain('--output-last-message')
    expect(capture.stdin).toBe('Review this diff')
    expect(capture.cwd).toBe(process.cwd())
    expect(capture.outputSchema).not.toBeNull()
    expect(capture.outputSchema?.properties).toHaveProperty('changesOverview')
    expect(capture.outputSchema?.required).toContain('changesOverview')
  })

  it('times out using the configured timeout and logs bounded output previews', async () => {
    const binPath = await createSlowFakeCodexBinary()
    const { logger, runner } = createRunner({
      bin: binPath,
      timeoutMs: 50,
    })

    const outcome = await runner.review({
      prompt: 'Review this diff',
      workingDirectory: '/tmp/pr-workspace',
    })

    expect(outcome).toEqual({
      ok: false,
      reason: 'Codex timed out after 50ms.',
    })
    const loggedTimeoutPayload = logger.error.mock.calls[0]?.[0] as {
      event: string
      reason: string
      timeoutMs: number
      stdoutBytes: number
      stderrBytes: number
    }

    expect(loggedTimeoutPayload.event).toBe('codex.failed')
    expect(loggedTimeoutPayload.reason).toBe('timeout')
    expect(loggedTimeoutPayload.timeoutMs).toBe(50)
    expect(typeof loggedTimeoutPayload.stdoutBytes).toBe('number')
    expect(typeof loggedTimeoutPayload.stderrBytes).toBe('number')
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'codex.failed',
        reason: 'timeout',
        timeoutMs: 50,
      }),
      'Codex review failed',
    )
  })

  it('cancels the Codex process when abort signal is triggered', async () => {
    const { binPath, cancelPath } = await createAbortAwareFakeCodexBinary()
    process.env.TEST_CANCEL_PATH = cancelPath
    const { logger, runner } = createRunner({
      bin: binPath,
      timeoutMs: 5_000,
    })
    const controller = new AbortController()

    const reviewPromise = runner.review({
      abortSignal: controller.signal,
      prompt: 'Review this diff',
      workingDirectory: '/tmp/pr-workspace',
    })

    await Promise.resolve()
    controller.abort()
    const outcome = await reviewPromise

    expect(outcome).toEqual({
      ok: false,
      reason: 'Codex review canceled.',
      cancelled: true,
    })
    try {
      const cancelMarker = await readFile(cancelPath, 'utf8')
      expect(cancelMarker).toBe('sigterm')
    } catch {
      expect(outcome).toMatchObject({
        cancelled: true,
        ok: false,
      })
    }
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'codex.canceled',
        status: 'canceled',
      }),
      'Codex review canceled',
    )
  })

  it('returns non-zero exit failures and logs detected failure hints', async () => {
    const binPath = await createFailingFakeCodexBinary({
      stderr: 'Rate limit exceeded with 429 from upstream',
    })
    const { logger, runner } = createRunner({
      bin: binPath,
      timeoutMs: 5_000,
    })

    const outcome = await runner.review({
      prompt: 'Review this diff',
      workingDirectory: '/tmp/pr-workspace',
    })

    expect(outcome).toEqual({
      ok: false,
      reason: 'Codex returned a non-zero exit code.',
    })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'codex.failed',
        failureHint: 'possible_rate_limited',
        reason: 'non_zero_exit',
      }),
      'Codex review failed',
    )
  })

  it('rejects schema-invalid JSON responses from single-phase review', async () => {
    const binPath = await createSchemaOutputFakeCodexBinary({
      output: JSON.stringify({
        summary: '',
        changesOverview: '',
        score: 9,
        decision: 'approve',
        findings: [],
      }),
    })
    const { logger, runner } = createRunner({
      bin: binPath,
      timeoutMs: 5_000,
    })

    const outcome = await runner.review({
      prompt: 'Review this diff',
      workingDirectory: '/tmp/pr-workspace',
    })

    expect(outcome).toEqual({
      ok: false,
      reason: 'Codex returned JSON that did not match the review schema.',
    })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'codex.failed',
        reason: 'invalid_json',
      }),
      'Codex review failed',
    )
  })

  it('accepts fenced JSON output from single-phase review', async () => {
    const binPath = await createSchemaOutputFakeCodexBinary({
      output: [
        '```json',
        JSON.stringify({
          summary: 'ok',
          changesOverview: '',
          score: 9,
          decision: 'approve',
          findings: [],
        }),
        '```',
      ].join('\n'),
    })
    const { runner } = createRunner({
      bin: binPath,
      timeoutMs: 5_000,
    })

    const outcome = await runner.review({
      prompt: 'Review this diff',
      workingDirectory: '/tmp/pr-workspace',
    })

    expect(outcome).toEqual({
      ok: true,
      result: {
        summary: 'ok',
        changesOverview: '',
        score: 9,
        decision: 'approve',
        findings: [],
      },
    })
  })
})
