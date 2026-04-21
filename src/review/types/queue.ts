import type { NormalizedPullRequestEvent } from './events.js'
import type { PullRequestContext } from './core.js'

export type QueueCancelReason = 'cancel_requested'

export type QueueRequest = {
  enqueuedAt: number
  completion: Promise<void>
  event: NormalizedPullRequestEvent
  resolveCompletion: () => void
}

export type ActiveRun = {
  abortController: AbortController
  cancellationLogged: boolean
  cancellationReason: QueueCancelReason | null
  context: PullRequestContext
  pullRequestKey: string
  runKey: string
}

export type ActiveRunRef = {
  current: ActiveRun | null
}
