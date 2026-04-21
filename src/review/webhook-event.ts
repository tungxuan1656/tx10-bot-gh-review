import { z } from 'zod'
import type { NormalizedPullRequestEvent, PullRequestActionKind } from './types.js'

export type { NormalizedPullRequestEvent, PullRequestActionKind } from './types.js'

export const trackedPullRequestActionKinds = [
  'review_requested',
  'review_request_removed',
  'synchronize',
  'other_pull_request_action',
] as const

const pullRequestWebhookPayloadSchema = z.object({
  action: z.string().min(1),
  before: z.string().min(1).optional(),
  after: z.string().min(1).optional(),
  sender: z
    .object({
      login: z.string().min(1),
    })
    .nullable()
    .optional(),
  repository: z.object({
    name: z.string().min(1),
    clone_url: z.string().min(1),
    owner: z.object({
      login: z.string().min(1),
    }),
  }),
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string().min(1),
    html_url: z.string().url(),
    head: z.object({
      ref: z.string().min(1),
      sha: z.string().min(1),
      repo: z
        .object({
          clone_url: z.string().min(1),
        })
        .nullable(),
    }),
    base: z.object({
      ref: z.string().min(1),
      sha: z.string().min(1),
      repo: z.object({
        clone_url: z.string().min(1),
      }),
    }),
    requested_reviewers: z
      .array(
        z.object({
          login: z.string().min(1),
        }),
      )
      .optional()
      .default([]),
  }),
  requested_reviewer: z
    .object({
      login: z.string().min(1),
    })
    .nullable()
    .optional(),
})

function toActionKind(action: string): PullRequestActionKind {
  if (action === 'review_requested') {
    return 'review_requested'
  }

  if (action === 'review_request_removed') {
    return 'review_request_removed'
  }

  if (action === 'synchronize') {
    return 'synchronize'
  }

  return 'other_pull_request_action'
}

export function normalizePullRequestEvent(input: {
  botLogin: string
  deliveryId: string
  payload: unknown
}):
  | {
      success: true
      data: NormalizedPullRequestEvent
    }
  | {
      success: false
      issues: z.ZodIssue[]
    } {
  const parsed = pullRequestWebhookPayloadSchema.safeParse(input.payload)

  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues,
    }
  }

  const requestedReviewerLogins =
    parsed.data.pull_request.requested_reviewers.map(
      (reviewer) => reviewer.login,
    )
  const actionKind = toActionKind(parsed.data.action)

  return {
    success: true,
    data: {
      deliveryId: input.deliveryId,
      eventName: 'pull_request',
      action: parsed.data.action,
      actionKind,
      owner: parsed.data.repository.owner.login,
      repo: parsed.data.repository.name,
      pullNumber: parsed.data.pull_request.number,
      title: parsed.data.pull_request.title,
      htmlUrl: parsed.data.pull_request.html_url,
      headSha: parsed.data.pull_request.head.sha,
      headRef: parsed.data.pull_request.head.ref,
      headCloneUrl:
        parsed.data.pull_request.head.repo?.clone_url ??
        parsed.data.repository.clone_url,
      baseSha: parsed.data.pull_request.base.sha,
      baseRef: parsed.data.pull_request.base.ref,
      baseCloneUrl: parsed.data.pull_request.base.repo.clone_url,
      senderLogin: parsed.data.sender?.login ?? null,
      requestedReviewerLogin: parsed.data.requested_reviewer?.login ?? null,
      requestedReviewerLogins,
      botStillRequested:
        actionKind === 'synchronize'
          ? requestedReviewerLogins.includes(input.botLogin)
          : null,
      beforeSha: parsed.data.before ?? null,
      afterSha: parsed.data.after ?? null,
    },
  }
}
