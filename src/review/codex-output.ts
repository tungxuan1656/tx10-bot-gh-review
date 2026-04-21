const maxLoggedOutputCharacters = 2_000
const maxLoggedOutputTailCharacters = 1_000

export const codexOutputJsonSchema = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      minLength: 1,
    },
    changesOverview: {
      type: 'string',
    },
    score: {
      type: 'number',
      minimum: 0,
      maximum: 10,
    },
    decision: {
      type: 'string',
      enum: ['approve', 'request_changes'],
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: {
            type: 'string',
            enum: ['critical', 'major', 'minor', 'improvement'],
          },
          path: {
            type: 'string',
            minLength: 1,
          },
          line: {
            type: 'integer',
            minimum: 1,
          },
          title: {
            type: 'string',
            minLength: 1,
          },
          comment: {
            type: 'string',
            minLength: 1,
          },
        },
        required: ['severity', 'path', 'line', 'title', 'comment'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'changesOverview', 'score', 'decision', 'findings'],
  additionalProperties: false,
} as const

export function stripJsonFences(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(trimmed)
  return fenced?.[1]?.trim() ?? trimmed
}

export function detectFailureHint(stderr: string): string | undefined {
  const lower = stderr.toLowerCase()

  if (
    lower.includes('context length') ||
    lower.includes('maximum context') ||
    lower.includes('too many tokens') ||
    lower.includes('input is too long') ||
    lower.includes('prompt is too long')
  ) {
    return 'possible_prompt_too_large'
  }

  if (lower.includes('rate limit') || lower.includes('429')) {
    return 'possible_rate_limited'
  }

  if (
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('authentication')
  ) {
    return 'possible_auth_error'
  }

  if (lower.includes('not found') || lower.includes('no such file')) {
    return 'possible_missing_resource'
  }

  return undefined
}

export function summarizeOutput(text: string): string | undefined {
  const trimmed = text.trim()

  if (trimmed.length === 0) {
    return undefined
  }

  if (trimmed.length <= maxLoggedOutputCharacters) {
    return trimmed
  }

  return `${trimmed.slice(0, maxLoggedOutputCharacters)}...[truncated]`
}

export function summarizeOutputTail(text: string): string | undefined {
  const trimmed = text.trim()

  if (trimmed.length === 0) {
    return undefined
  }

  if (trimmed.length <= maxLoggedOutputTailCharacters) {
    return trimmed
  }

  return `...[truncated]${trimmed.slice(-maxLoggedOutputTailCharacters)}`
}
