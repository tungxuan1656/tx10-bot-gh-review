# Review Playbook

Use this playbook on every review. The goal is a consistent, reproducible, high-signal review process.

## Review Goal

Prevent semantic bugs, design mistakes, regressions, performance problems, security flaws, and weak test coverage from reaching merge.

## Phase 1: Scope and Risk Setup

1. Identify the review target.
   - Staged diff, working-tree diff, commit, or pull request.
2. Resolve the review boundary.
   - Use the real base/head refs or PR base/head metadata when available.
3. List changed files and affected flows.
4. Mark high-risk areas early.
   - Form or payload handling
   - Query or store bridges
   - State ownership
   - Authentication or permission paths
   - Error handling
   - i18n
   - Polling, timers, concurrency, retries
   - Data mapping and contract transformations

## Phase 2: Objective Validation Baseline

1. Run the narrowest relevant checks when practical.
   - Lint
   - Typecheck
   - Tests
   - CI or status checks
2. Capture failures as evidence, not as guesses.
3. Do not stop at automation. Manual review is still required even when checks pass.

## Phase 3: Full-Context Reading

1. Read each changed file in full.
2. Read adjacent tests and affected call sites.
3. Read imported helpers, contracts, schemas, selectors, or adapters when they affect the changed behavior.
4. Verify that comments, TODOs, and naming still match the code after the change.

## Phase 4: Change Summary First

Before listing issues, summarize:

- what changed
- which user or system flows are affected
- which trust boundaries or contracts are involved
- where the highest regression risk lives

Keep the summary factual. Do not bury findings inside it.

## Phase 5: Semantic Walkthrough

For each high-risk flow, inspect:

1. User journey
   - What the user does and what must happen next.
2. Action contract
   - Label -> handler -> payload -> side effect -> expected result.
3. Payload matrix
   - Each user input maps to a request field, state transition, or explicit omission rule.
4. Failure matrix
   - Empty, invalid, denied, timeout, network failure, retry, and recovery behavior.

## Phase 6: High-Value Probes

Apply these probes wherever relevant:

- `Source of truth`: one owner for critical state and one dataset for each shared surface.
- `Empty vs omitted`: explicit clears are not silently dropped.
- `Lifecycle`: mount, loading, success, refetch, error, close, and unmount remain coherent.
- `Concurrency`: double submit, rapid toggle, reopen, retry, and race conditions are safe.
- `Consistency`: the same filter or selection produces the same result across all surfaces.
- `Error recovery`: failure states have a meaningful retry, close, back, or support path.
- `Action reality`: every visible control has a real effect and correct semantics.
- `Regression`: changed logic and bug fixes have executable test coverage.
- `Fix closure`: follow-up patches actually resolve prior findings end to end.

## Phase 7: Rule Application

Use the rule catalog to check:

- correctness and behavior
- security and privacy
- data integrity and contracts
- lifecycle and concurrency
- performance
- architecture and maintainability
- tests and regressions
- i18n and accessibility
- documentation and hygiene

## Phase 8: Findings Scoring

For each potential finding:

1. Confirm the exact evidence.
2. Decide whether it is a defect or only an improvement.
3. Assign severity.
4. Assign confidence.
5. Skip it if it does not meet the confidence threshold for reporting.

## Phase 9: Final Review

Write the final review in this order:

1. `Change Summary`
2. `Reference Skills`
3. `Findings`
4. `Evidence Table`
5. `Previous Findings Closure` when applicable
6. `Verdict`
7. `Missing Validation`

## Follow-Up Review Rule

When reviewing a patch that claims to fix previous feedback:

1. Build a closure table for prior findings.
2. Re-check each prior finding at the exact location or moved equivalent.
3. Verify end-to-end behavior, not just code movement.
4. Mark each prior finding as `Fixed`, `Still Open`, `Partially Addressed`, or `Superseded by New Issue`.
