export type RoutedPullRequestEvent =
  | {
      status: 'trigger_review'
      reason: 'review_requested'
    }
  | {
      status: 'cancel_requested'
      reason: 'cancel_requested'
    }
  | {
      status: 'ignored'
      reason:
        | 'approved_before'
        | 'reviewer_mismatch'
        | 'synchronize_ignored'
        | 'unsupported_action'
    }

export type ReviewMode = 'initial_review' | 're_review'

export type ReReviewDelta = {
  deltaFromRef: string
  deltaToRef: string
  fallbackReason: string | null
}
