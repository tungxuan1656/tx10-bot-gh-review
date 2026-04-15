# Runbook

## Start the Service

```bash
pnpm install
pnpm dev
```

## Health Check

Use:

```bash
curl http://localhost:43191/healthz
```

Expected response:

```json
{"status":"ok"}
```

## Common Failure Modes

### Invalid webhook signature

- Symptom: `401` from `/github/webhooks`
- Check that the repository or organization webhook secret matches `GITHUB_WEBHOOK_SECRET`
- Confirm the webhook request reaches the service unmodified by proxies

### Codex failure comment appears on the PR

- Check that `CODEX_BIN` resolves to a working Codex CLI binary
- Check that `CODEX_MODEL` is set to a supported model in your environment
- Run `codex --help` on the host to confirm availability
- Inspect service logs for timeout or non-zero exit warnings
- For non-zero exits, inspect `failureHint`, `stderrTailPreview`, and `stdoutTailPreview` on `codex.failed`
- Confirm `resources/review-skills/` exists in the deployed service and can be copied into the temp workspace

### No review was published

- Confirm the event was `pull_request` with action `review_requested`
- Confirm `requested_reviewer.login` matched `GITHUB_BOT_LOGIN`
- For `synchronize` events, confirm `pull_request.requested_reviewers` still contains `GITHUB_BOT_LOGIN`
- Confirm the PR includes reviewable file types with patch hunks
- Check whether the head SHA already has a marker comment or review from a prior run
- Check whether the PR is approved-locked and `REVIEW_APPROVED_LOCK_ENABLED=true`
- Check whether a later `review_request_removed` or newer commit canceled the in-flight run before publish

### Inline findings were moved into the summary

- GitHub only accepts review comments on lines present in the diff hunk
- This fallback is expected when Codex points to a line outside the commentable right side of the patch

## Operational Notes

- The MVP stores queue state in memory and persistent dedupe state on the PR itself via HTML comment markers.
- Work is processed through one global FIFO queue across all repos and PRs in this process.
- A new commit for the currently running PR preempts the run and hard-cancels the active Codex process.
- Discussion context is fetched from GitHub per run and stored in `pr-review-comments.md` inside the workspace, with cached snapshots cleaned by TTL.
- A bot `APPROVE` can lock the PR from further auto-review when `REVIEW_APPROVED_LOCK_ENABLED=true`.
- The fallback comment is intentionally neutral and never blocks merging on transient infrastructure failures.
- Non-blocking findings are still published as an `APPROVE` review when the response decision is consistent with the severity policy.

## Logging Guide

Set `LOG_LEVEL=info` for normal debugging and `LOG_LEVEL=debug` when you need deeper step-by-step traces.
Set `LOG_PRETTY=true` to force human-readable timeline logs, or keep `LOG_PRETTY=auto` (default) to enable pretty logs automatically in development terminals.

Main lifecycle logs in order:

1. `Webhook received`
2. `Webhook verified`
3. `Webhook routed`
4. `Review started`
5. `Review idempotency checked`
6. `Review pr_info fetched`
7. `Review workspace prepared`
8. `Review prompts built`
9. `Review Codex step completed` or `Review Codex step failed`
10. `Review publish started`
11. `Review published` or `Review publish fallback`
12. `Review completed`

Use `runKey` to trace one request end-to-end. The format is:

`owner/repo#pullNumber@headSha`

Each log line now also carries structured fields such as:

- `component`
- `event`
- `status`
- `deliveryId`
- `action`
- `owner`, `repo`, `pullNumber`, `headSha`
- `requestedReviewerLogin`
- `reason`
- `runKey`

## Pull Request Action Matrix

| GitHub action | Routed status | Reason | Runtime behavior |
| --- | --- | --- | --- |
| `review_requested` for the bot | `trigger_review` | n/a | Start a review run |
| `review_requested` for another reviewer | `ignored` | `reviewer_mismatch` | Do nothing |
| `synchronize` with bot still requested | `trigger_review` | n/a | Enqueue re-review for latest head SHA |
| `synchronize` without bot requested | `ignored` | `bot_not_requested` | Do nothing |
| `review_request_removed` for the bot | `cancel_requested` | `cancel_requested` | Best-effort cancel in-flight run |
| Other pull request actions | `ignored` | `unsupported_action` | Do nothing |

## Sample Outcomes

### `review_requested`

- `webhook.routed` with `status=trigger_review`
- `review.started`
- normal review lifecycle until `review.published`

### `synchronize`

- `webhook.routed` with `status=trigger_review` when `botStillRequested=true`
- If the same PR is in-flight with an older head SHA, the current run is canceled and a new run is queued
- `webhook.routed` with `status=ignored` and `reason=bot_not_requested` when `botStillRequested=false`

### `review_request_removed`

- `webhook.routed` with `status=cancel_requested`
- `review.cancel_requested`
- `review.canceled` if the run stops before publish
- `review.cancel_missed` if the review was already published or there was no in-flight run

If a review fails, check these logs first:

- `review.idempotency_checked`
- `review.codex_failed`
- `review.failed`
- `review.cancel_requested`
- `review.canceled`
