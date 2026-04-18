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
   - Input or payload handling
   - State ownership and source of truth
   - Authentication or permission paths
   - Error handling and propagation
   - Async operations, polling, timers, concurrency, retries
   - Data mapping, contract transformations, and type boundaries
5. Verify the PR description matches the actual scope of changes.
   - If the stated intent is narrower, broader, or different from what the diff shows, flag it.

## Phase 2: Available Validation Signals

1. Note any validation results already available as context: CI status, prior review comments, or linked test output.
2. Do not assume checks passed if they are not mentioned. Note absent signals in `Missing Validation`.
3. Proceed with full manual review regardless of signal availability. External checks do not replace inspection.

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

1. Trigger and flow
   - What initiates the action and what must happen at each subsequent step.
2. Action contract
   - Input → handler → computation → side effect → expected output.
3. Input contract
   - Each input field maps to a processing step, transformation, or explicit omission rule.
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
- `Token-level scan`: after the semantic walkthrough, scan every line of the diff once more for small issues that holistic reading misses — magic literals, missing `void` or `await`, unsafe `!` assertions, suspicious type casts, off-by-one index expressions, and wrong operator choices.

## Phase 7: Coverage Guard

Consciously check all dimensions below and avoid generic pass statements:

- Correctness and logic
- Edge cases and failure modes
- Security and privacy
- Performance and scalability
- Data integrity and contracts
- Concurrency and lifecycle
- Code quality and maintainability
- Consistency with the existing codebase
- UX and user flow when applicable

## Phase 8: Rule Application

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

## Phase 9: Attack Mode (Break-the-Code Pass)

After evidence-based inspection, run a second adversarial pass:

1. Assume the changed flow is fragile.
2. Stress invalid input, race conditions, retries, async ordering, and partial data.
3. Identify at least 3 concrete failure scenarios with:
   - trigger
   - failure behavior
   - impacted flow

Capture these as findings only when evidence meets thresholds; otherwise place them in `Potential Risks`.

## Phase 10: Findings and Risks Scoring

For each potential issue:

1. Confirm the exact evidence.
2. Decide whether it belongs in `Findings` (high confidence) or `Potential Risks` (lower confidence).
3. Assign severity.
4. Assign confidence.
5. For findings, enforce high-confidence thresholds.
6. For potential risks, include explicit assumptions and a mitigation suggestion.

## Phase 11: Final Review

Write the final review in this order:

1. `Change Summary`
2. `Reference Skills`
3. `Findings`
4. `Potential Risks`
5. `Evidence Table`
6. `Previous Findings Closure` when applicable
7. `Verdict`
8. `Missing Validation`

## Follow-Up Review Rule

When reviewing a patch that claims to fix previous feedback:

1. Build a closure table for prior findings.
2. Re-check each prior finding at the exact location or moved equivalent.
3. Verify end-to-end behavior, not just code movement.
4. Mark each prior finding as `Fixed`, `Still Open`, `Partially Addressed`, or `Superseded by New Issue`.
