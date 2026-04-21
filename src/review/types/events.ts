export type PullRequestActionKind =
  | 'review_requested'
  | 'review_request_removed'
  | 'synchronize'
  | 'other_pull_request_action'

export type NormalizedPullRequestEvent = {
  deliveryId: string
  eventName: 'pull_request'
  action: string
  actionKind: PullRequestActionKind
  owner: string
  repo: string
  pullNumber: number
  title: string
  htmlUrl: string
  headSha: string
  headRef: string
  headCloneUrl: string
  baseSha: string
  baseRef: string
  baseCloneUrl: string
  senderLogin: string | null
  requestedReviewerLogin: string | null
  requestedReviewerLogins: string[]
  botStillRequested: boolean | null
  beforeSha: string | null
  afterSha: string | null
}
