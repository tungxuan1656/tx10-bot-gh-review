import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCodexRunner } from '../src/review/codex.js'
import { reviewResultSchema } from '../src/review/types.js'

const createdDirectories: string[] = []

afterEach(async () => {
  delete process.env.TEST_CAPTURE_PATH
  delete process.env.TEST_CANCEL_PATH
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

async function createFakeCodexBinary(): Promise<{
  binPath: string
  capturePath: string
}> {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'codex-runner-test-'),
  )
  createdDirectories.push(tempDirectory)
  const capturePath = path.join(tempDirectory, 'capture.json')
  const binPath = path.join(tempDirectory, 'fake-codex.mjs')

  await writeFile(
    binPath,
    [
      '#!/usr/bin/env node',
      "import { readFile, writeFile } from 'node:fs/promises';",
      '',
      'const args = process.argv.slice(2);',
      'const stdin = await new Promise((resolve, reject) => {',
      '  const chunks = [];',
      "  process.stdin.on('data', (chunk) => chunks.push(chunk));",
      "  process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));",
      "  process.stdin.on('error', reject);",
      '});',
      "const schemaIndex = args.indexOf('--output-schema');",
      'const outputSchema =',
      '  schemaIndex >= 0',
      "    ? JSON.parse(await readFile(args[schemaIndex + 1], 'utf8'))",
      '    : null;',
      "const outputIndex = args.indexOf('--output-last-message');",
      'const outputPath = args[outputIndex + 1];',
      'await writeFile(',
      '  process.env.TEST_CAPTURE_PATH,',
      '  JSON.stringify({',
      '    args,',
      '    cwd: process.cwd(),',
      '    stdin,',
      '    outputSchema,',
      '  }),',
      ');',
      'await writeFile(',
      '  outputPath,',
      "  JSON.stringify({ summary: 'ok', score: 9, decision: 'approve', findings: [] }),",
      ');',
    ].join('\n'),
    'utf8',
  )
  await chmod(binPath, 0o755)

  return {
    binPath,
    capturePath,
  }
}

async function createSlowFakeCodexBinary(): Promise<string> {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'codex-runner-slow-test-'),
  )
  createdDirectories.push(tempDirectory)
  const binPath = path.join(tempDirectory, 'slow-fake-codex.mjs')

  await writeFile(
    binPath,
    [
      '#!/usr/bin/env node',
      'await new Promise((resolve) => setTimeout(resolve, 200));',
      "process.stdout.write('still running');",
    ].join('\n'),
    'utf8',
  )
  await chmod(binPath, 0o755)

  return binPath
}

async function createFailingFakeCodexBinary(input: {
  stderr: string
}): Promise<string> {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'codex-runner-fail-test-'),
  )
  createdDirectories.push(tempDirectory)
  const binPath = path.join(tempDirectory, 'fail-fake-codex.mjs')

  await writeFile(
    binPath,
    [
      '#!/usr/bin/env node',
      `console.error(${JSON.stringify(input.stderr)})`,
      'process.exit(2)',
    ].join('\n'),
    'utf8',
  )
  await chmod(binPath, 0o755)

  return binPath
}

async function createSchemaInvalidFakeCodexBinary(input: {
  output: string
}): Promise<string> {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'codex-runner-invalid-schema-test-'),
  )
  createdDirectories.push(tempDirectory)
  const binPath = path.join(tempDirectory, 'invalid-schema-fake-codex.mjs')

  await writeFile(
    binPath,
    [
      '#!/usr/bin/env node',
      "import { writeFile } from 'node:fs/promises';",
      'const args = process.argv.slice(2);',
      "const outputIndex = args.indexOf('--output-last-message');",
      'const outputPath = args[outputIndex + 1];',
      `await writeFile(outputPath, ${JSON.stringify(input.output)}, 'utf8');`,
    ].join('\n'),
    'utf8',
  )
  await chmod(binPath, 0o755)

  return binPath
}

async function createTwoPhaseFakeCodexBinary(input: {
  phase1Output: string
  phase2Output: string
}): Promise<{
  binPath: string
  capturePath: string
}> {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'codex-runner-two-phase-test-'),
  )
  createdDirectories.push(tempDirectory)
  const capturePath = path.join(tempDirectory, 'capture.json')
  const binPath = path.join(tempDirectory, 'two-phase-fake-codex.mjs')

  await writeFile(
    binPath,
    [
      '#!/usr/bin/env node',
      "import { readFile, writeFile } from 'node:fs/promises';",
      'const args = process.argv.slice(2);',
      "const outputIndex = args.indexOf('--output-last-message');",
      'const outputPath = args[outputIndex + 1];',
      'const stdin = await new Promise((resolve, reject) => {',
      '  const chunks = [];',
      "  process.stdin.on('data', (chunk) => chunks.push(chunk));",
      "  process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));",
      "  process.stdin.on('error', reject);",
      '});',
      'let capture = [];',
      'try {',
      "  capture = JSON.parse(await readFile(process.env.TEST_CAPTURE_PATH, 'utf8'));",
      '} catch {}',
      'capture.push({ stdin, args });',
      'await writeFile(process.env.TEST_CAPTURE_PATH, JSON.stringify(capture), "utf8");',
      `const output = capture.length === 1 ? ${JSON.stringify(input.phase1Output)} : ${JSON.stringify(input.phase2Output)};`,
      'await writeFile(outputPath, output, "utf8");',
    ].join('\n'),
    'utf8',
  )
  await chmod(binPath, 0o755)

  return {
    binPath,
    capturePath,
  }
}

async function createAbortAwareFakeCodexBinary(): Promise<{
  binPath: string
  cancelPath: string
}> {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'codex-runner-cancel-test-'),
  )
  createdDirectories.push(tempDirectory)
  const cancelPath = path.join(tempDirectory, 'cancelled.txt')
  const binPath = path.join(tempDirectory, 'cancel-fake-codex.mjs')

  await writeFile(
    binPath,
    [
      '#!/usr/bin/env node',
      "import { writeFile } from 'node:fs/promises';",
      "process.on('SIGTERM', async () => {",
      "  await writeFile(process.env.TEST_CANCEL_PATH, 'sigterm', 'utf8');",
      '  process.exit(0);',
      '});',
      'await new Promise(() => {});',
    ].join('\n'),
    'utf8',
  )
  await chmod(binPath, 0o755)

  return {
    binPath,
    cancelPath,
  }
}

describe('reviewResultSchema', () => {
  it('accepts the expected Codex response shape', () => {
    const parsed = reviewResultSchema.safeParse({
      summary: 'Looks mostly good.',
      changesOverview: '',
      score: 8.5,
      decision: 'approve',
      findings: [
        {
          severity: 'minor',
          path: 'src/app.ts',
          line: 14,
          title: 'Unhandled JSON parsing',
          comment: 'Wrap JSON.parse in try/catch.',
        },
      ],
    })

    expect(parsed.success).toBe(true)
  })

  it('rejects invalid finding shapes', () => {
    const parsed = reviewResultSchema.safeParse({
      summary: 'Nope.',
      score: 12,
      decision: 'approve',
      findings: [],
    })

    expect(parsed.success).toBe(false)
  })

  it('rejects legacy decision and severity values', () => {
    const parsed = reviewResultSchema.safeParse({
      summary: 'Legacy response.',
      score: 8,
      decision: 'comment',
      findings: [
        {
          severity: 'medium',
          path: 'src/app.ts',
          line: 14,
          title: 'Legacy severity',
          comment: 'Old taxonomy should fail.',
        },
      ],
    })

    expect(parsed.success).toBe(false)
  })

  it('accepts explicit and missing changesOverview values', () => {
    const withOverview = reviewResultSchema.safeParse({
      summary: 'Looks good.',
      changesOverview: 'Added a new validation step.',
      score: 9,
      decision: 'approve',
      findings: [],
    })
    expect(withOverview.success).toBe(true)

    const withoutOverview = reviewResultSchema.parse({
      summary: 'Looks good.',
      score: 9,
      decision: 'approve',
      findings: [],
    })
    expect(withoutOverview.changesOverview).toBe('')
  })
})

describe('createCodexRunner', () => {
  it('defaults to a 15 minute timeout budget', async () => {
    const { binPath, capturePath } = await createFakeCodexBinary()
    process.env.TEST_CAPTURE_PATH = capturePath
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const runner = createCodexRunner({
      bin: binPath,
      logger: logger as never,
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
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const runner = createCodexRunner({
      bin: binPath,
      logger: logger as never,
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

    const capture = JSON.parse(await readFile(capturePath, 'utf8')) as {
      args: string[]
      cwd: string
      stdin: string
      outputSchema: {
        properties: Record<string, unknown>
        required: string[]
      } | null
    }

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
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const runner = createCodexRunner({
      bin: binPath,
      logger: logger as never,
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
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const runner = createCodexRunner({
      bin: binPath,
      logger: logger as never,
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
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const runner = createCodexRunner({
      bin: binPath,
      logger: logger as never,
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
    const binPath = await createSchemaInvalidFakeCodexBinary({
      output: JSON.stringify({
        summary: '',
        changesOverview: '',
        score: 9,
        decision: 'approve',
        findings: [],
      }),
    })
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const runner = createCodexRunner({
      bin: binPath,
      logger: logger as never,
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
    const binPath = await createSchemaInvalidFakeCodexBinary({
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
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const runner = createCodexRunner({
      bin: binPath,
      logger: logger as never,
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

  it('runs the two-phase flow and passes phase one output into phase two prompt builder', async () => {
    const { binPath, capturePath } = await createTwoPhaseFakeCodexBinary({
      phase1Output: 'phase-one-summary',
      phase2Output: JSON.stringify({
        summary: 'ok',
        changesOverview: '',
        score: 9,
        decision: 'approve',
        findings: [],
      }),
    })
    process.env.TEST_CAPTURE_PATH = capturePath
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const runner = createCodexRunner({
      bin: binPath,
      logger: logger as never,
      timeoutMs: 5_000,
    })
    const phase2Prompt = vi.fn((phase1Output: string) => `phase2:${phase1Output}`)

    const outcome = await runner.reviewTwoPhase({
      phase1Prompt: 'phase1',
      phase2Prompt,
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
    expect(phase2Prompt).toHaveBeenCalledWith('phase-one-summary')

    const capture = JSON.parse(await readFile(capturePath, 'utf8')) as Array<{
      stdin: string
    }>
    expect(capture).toHaveLength(2)
    expect(capture[0]?.stdin).toBe('phase1')
    expect(capture[1]?.stdin).toBe('phase2:phase-one-summary')
  })

  it('returns the phase one failure without running phase two', async () => {
    const binPath = await createFailingFakeCodexBinary({
      stderr: 'prompt is too long',
    })
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const runner = createCodexRunner({
      bin: binPath,
      logger: logger as never,
      timeoutMs: 5_000,
    })
    const phase2Prompt = vi.fn()

    const outcome = await runner.reviewTwoPhase({
      phase1Prompt: 'phase1',
      phase2Prompt,
      workingDirectory: '/tmp/pr-workspace',
    })

    expect(outcome).toEqual({
      ok: false,
      reason: 'Codex returned a non-zero exit code.',
    })
    expect(phase2Prompt).not.toHaveBeenCalled()
  })
})
