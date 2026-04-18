# Review Flow (Expected)

This document defines the expected pull request review flow for the bot.

## 1. Trigger Rules

The bot only reacts to explicit manual review requests.

- `pull_request` + `review_requested` for this bot login: trigger review.
- `pull_request` + `review_request_removed` for this bot login: cancel queued or in-flight review for that PR.
- `pull_request` + `synchronize`: always ignored.

Notes:

- A push to PR branch (`synchronize`) must not auto-trigger review.
- Re-review is started only by a new manual `review_requested` action.

## 2. Review Mode Selection

When a `review_requested` event is accepted, the bot must classify run mode:

- `initial_review`: no prior successful bot review exists on this PR.
- `re_review`: at least one prior successful bot review exists on this PR.

Prior successful review means a bot-authored review result was published for this PR (for example `APPROVE` or `REQUEST_CHANGES`).

Important rule:

- A failed attempt does not count as prior success.
- If first attempt failed and no successful bot review artifact exists, next `review_requested` is still `initial_review`.

## 3. Initial Review Flow (First Successful Review)

Initial review uses 2 phases.

### Phase 1: PR Metadata Summary

Goal:

- Read PR metadata and commit list from `pr-info.yaml`.
- Produce concise summary for downstream reasoning.

Input:

- PR metadata in workspace (`pr-info.yaml`).

Output:

- Short markdown summary.

### Phase 2: Deep Review (JSON)

Goal:

- Perform full review and return strict JSON output.

Prompt requirements:

- Must instruct model to read `code-review` skill and relevant references before reviewing.
- Must review diff and file context from prepared workspace refs.
- Must focus on concrete correctness, security, and validation issues.
- Must avoid purely stylistic findings.

Output contract:

- JSON object with `summary`, `score`, `decision`, `findings`.
- `changesOverview` is optional. If model has useful overview, return it; if not, omit it.

## 4. Re-review Flow (Second Request Onward)

Re-review uses 1 phase only (fast path).

### Fast Re-review Phase (JSON)

Goal:

- Focus on new changes since last successful bot-reviewed SHA.
- Verify whether previously raised issues (especially blocking/request-changes points) were addressed.
- Avoid full re-review of unchanged scope.

Mandatory context:

- Fetch prior PR discussion/comments/reviews every re-review run.
- Include previous bot findings and maintainer replies as input context.

Diff focus:

- Primary range: `last_successful_reviewed_sha..current_head_sha`.
- If old SHA cannot be resolved safely, fallback deterministically to current PR diff.

Prompt requirements:

- Prompt language must be different from initial flow.
- No requirement to re-read full `code-review` skill bundle for this fast path.

Output contract:

- Same JSON schema as initial flow.
- `changesOverview` remains optional.

## 5. Publish Rules

Decision mapping remains deterministic:

- Any `critical` or `major` finding => publish `REQUEST_CHANGES`.
- Only `minor`/`improvement` findings or no findings => publish `APPROVE`.

Additional notes:

- Inline comments should be published when location is valid.
- If inline target is invalid, fallback to top-level review body and do not fail entire review.
- Include `changesOverview` in body only when present.

## 6. Idempotency and Retry Expectations

- `synchronize` ignore must never suppress future manual re-review.
- A new manual `review_requested` should still run review even if head SHA equals a previously synchronized commit.
- First-run failure must not lock PR into re-review mode.

## 7. End-to-End Scenarios

### Scenario A: First Request

1. Maintainer requests review.
2. Bot runs `initial_review` (2 phases).
3. Bot publishes review result.

### Scenario B: Push New Commits

1. Author pushes commits (`synchronize`).
2. Bot ignores event.
3. No auto review is created.

### Scenario C: Manual Re-review

1. Maintainer requests review again.
2. Bot detects prior successful review.
3. Bot runs `re_review` (1 fast phase, commit delta + old findings check).
4. Bot publishes updated review result.

### Scenario D: First Attempt Failed

1. Maintainer requests review.
2. Pipeline fails before publishing successful review.
3. Maintainer requests review again.
4. Bot still treats this run as `initial_review` (2 phases).
