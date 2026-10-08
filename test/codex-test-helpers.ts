import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'

import { createCodexRunner } from '../src/review/codex.js'
import { buildInspectionCommand } from '../src/review/codex-completion.js'

const createdDirectories: string[] = []

export const testInspectionScope = {
  range: 'refs/codex-review/base...refs/codex-review/head',
  paths: ['src/app.ts'],
}
export const testDiffOutput = 'verified-diff\n'
const completedTurn = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } }) + '\n'
const defaultCodexEvents = JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'item_0', type: 'command_execution', status: 'completed', exit_code: 0,
    command: buildInspectionCommand('/tmp/pr-workspace', testInspectionScope).command,
    aggregated_output: testDiffOutput,
  },
}) + '\n' + completedTurn

export async function cleanupCodexTestArtifacts(): Promise<void> {
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
      `  ${JSON.stringify(capturePath)},`,
      '  JSON.stringify({',
      '    args,',
      '    cwd: process.cwd(),',
      '    stdin,',
      '    outputSchema,',
      '    environment: Object.fromEntries(["GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET", "UNRELATED_SECRET", "OPENAI_API_KEY", "HOME", "PATH", "CODEX_HOME"].map((key) => [key, process.env[key]])),',
      '  }),',
      ');',
      'await writeFile(',
      '  outputPath,',
      "  JSON.stringify({ reviewStatus: 'complete', incompleteReason: '', summary: 'ok', score: 9, decision: 'approve', findings: [] }),",
      ');',
      `process.stdout.write(${JSON.stringify(defaultCodexEvents)});`,
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
  stdout?: string
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
      `process.stdout.write(${JSON.stringify(input.stdout ?? '')})`,
      'process.exit(2)',
    ].join('\n'),
    'utf8',
  )
  await chmod(binPath, 0o755)

  return binPath
}

export async function createSchemaOutputFakeCodexBinary(input: {
  output: string
  stdout?: string
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
      `process.stdout.write(${JSON.stringify(input.stdout ?? defaultCodexEvents)});`,
    ].join('\n'),
    'utf8',
  )
  await chmod(binPath, 0o755)

  return binPath
}

export async function createTwoPhaseFakeCodexBinary(input: {
  phase1Output: string
  phase2Output: string
  phase1Stdout?: string
  phase2Stdout?: string
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
      `  capture = JSON.parse(await readFile(${JSON.stringify(capturePath)}, 'utf8'));`,
      '} catch {}',
      'capture.push({ stdin, args });',
      `await writeFile(${JSON.stringify(capturePath)}, JSON.stringify(capture), "utf8");`,
      `const output = capture.length === 1 ? ${JSON.stringify(input.phase1Output)} : ${JSON.stringify(input.phase2Output)};`,
      'await writeFile(outputPath, output, "utf8");',
      `process.stdout.write(capture.length === 1 ? ${JSON.stringify(input.phase1Stdout ?? completedTurn)} : ${JSON.stringify(input.phase2Stdout ?? defaultCodexEvents)});`,
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
      `  await writeFile(${JSON.stringify(cancelPath)}, 'sigterm', 'utf8');`,
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
