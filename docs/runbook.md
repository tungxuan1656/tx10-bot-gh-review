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
- Run `codex --help` on the host to confirm availability
- Inspect service logs for timeout or non-zero exit warnings

### No review was published

- Confirm the event was `pull_request` with action `review_requested`
- Confirm `requested_reviewer.login` matched `GITHUB_BOT_LOGIN`
- Confirm the PR includes reviewable file types with patch hunks
- Check whether the head SHA already has a marker comment or review from a prior run

### Inline findings were moved into the summary

- GitHub only accepts review comments on lines present in the diff hunk
- This fallback is expected when Codex points to a line outside the commentable right side of the patch

## Operational Notes

- The MVP stores in-flight dedupe state in memory and persistent dedupe state on the PR itself via HTML comment markers.
- A new commit naturally invalidates the previous marker because the head SHA changes, but this service will not re-review until the bot is explicitly requested again.
- The fallback comment is intentionally neutral and never blocks merging on transient infrastructure failures.

## Logging Guide

Set `LOG_LEVEL=info` for normal debugging and `LOG_LEVEL=debug` when you need deeper step-by-step traces.
Set `LOG_PRETTY=true` to force human-readable timeline logs, or keep `LOG_PRETTY=auto` (default) to enable pretty logs automatically in development terminals.

Main lifecycle logs in order:

1. `Received GitHub webhook`
2. `Dispatching pull_request webhook for processing`
3. `Accepted pull_request review request for processing`
4. `Review run started`
5. `Fetched changed files from pull request`
6. `Hydrated reviewable files with patch and content`
7. `Codex review completed with valid result` or `Codex review failed; publishing neutral failure comment`
8. `Publishing pull request review`
9. `Published pull request review` (or fallback mode log)
10. `Review run completed`

Use `runKey` to trace one request end-to-end. The format is:

`owner/repo#pullNumber@headSha`

If a review fails, check these logs first:

- `Idempotency check returned not found; continuing review run`
- `Codex review timed out`
- `Pull request review run failed`
- `Failed to publish fallback failure comment`
