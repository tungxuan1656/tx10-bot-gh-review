import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'

import { createCodexRunner } from '../src/review/codex.js'

const createdDirectories: string[] = []

export async function cleanupCodexTestArtifacts(): Promise<void> {
  delete process.env.TEST_CAPTURE_PATH
  delete process.env.TEST_CANCEL_PATH
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
}

function createLoggerStub() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }
}

export function createRunner(input: {
  bin: string
  timeoutMs?: number
}) {
  const logger = createLoggerStub()

  return {
    logger,
    runner: createCodexRunner({
      bin: input.bin,
      logger: logger as never,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    }),
  }
}

export async function createFakeCodexBinary(): Promise<{
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

export async function createSlowFakeCodexBinary(): Promise<string> {
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

export async function createFailingFakeCodexBinary(input: {
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

export async function createSchemaOutputFakeCodexBinary(input: {
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

export async function createTwoPhaseFakeCodexBinary(input: {
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

export async function createAbortAwareFakeCodexBinary(): Promise<{
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

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T
}
