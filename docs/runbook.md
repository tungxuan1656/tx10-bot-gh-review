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
- Check that GitHub App webhook secret matches `GITHUB_WEBHOOK_SECRET`
- Confirm the webhook request reaches the service unmodified by proxies

### Codex failure comment appears on the PR

- Check that `CODEX_BIN` resolves to a working Codex CLI binary
- Run `codex --help` on the host to confirm availability
- Inspect service logs for timeout or non-zero exit warnings

### No review was published

- Confirm the event was one of:
  - `opened`
  - `reopened`
  - `synchronize`
  - `review_requested`
- Confirm the PR includes reviewable file types with patch hunks
- Check whether the head SHA already has a marker comment or review from a prior run

### Inline findings were moved into the summary

- GitHub only accepts review comments on lines present in the diff hunk
- This fallback is expected when Codex points to a line outside the commentable right side of the patch

## Operational Notes

- The MVP stores in-flight dedupe state in memory and persistent dedupe state on the PR itself via HTML comment markers.
- A new commit naturally invalidates the previous marker because the head SHA changes.
- The fallback comment is intentionally neutral and never blocks merging on transient infrastructure failures.
