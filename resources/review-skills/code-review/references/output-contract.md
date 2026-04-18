# Output Contract

Use this structure unless the user explicitly asked for a different format.

## Section Order

1. `Change Summary`
2. `Reference Skills`
3. `Findings`
4. `Potential Risks`
5. `Evidence Table`
6. `Previous Findings Closure` when applicable
7. `Verdict`
8. `Missing Validation`

## Formatting Rules

- Keep the summary factual and short.
- Group findings by `Critical`, `Major`, `Minor`, and `Improvement`.
- `Findings` should include high-confidence issues only.
- `Potential Risks` should include lower-confidence but meaningful concerns.
- Every finding must include:
  - confidence score
  - evidence
  - issue description
  - why it matters
  - suggested fix
- Every potential risk must include:
  - confidence score in the `60-74` range
  - reasoning grounded in code
  - explicit assumptions
  - suggested mitigation
- If a severity bucket has no findings, write `None`.
- If no findings exist, say so explicitly and still provide verdict and missing-validation notes.

## Recommended Template

```markdown
## Change Summary
- Briefly describe what changed.
- Name the affected flows, contracts, or trust boundaries.
- Call out the highest regression risks.

## Reference Skills
- `coding-standards`: baseline readability and maintainability checks.
- `typescript-reviewer`: type safety and async correctness.

## Findings
### Critical
- None

### Major
- `[confidence: 86/100]` Retry path can publish duplicate comments.
  Evidence: `src/review/run-review.ts:71`
  Why it matters: The flow is no longer idempotent for the same review target.
  Suggested fix: Reuse the existing idempotency guard before each publish attempt.

### Minor
- None

### Improvement
- `[confidence: 75/100]` Add a regression test for invalid inline target fallback.
  Evidence: `test/review/publish-review.test.ts`
  Why it matters: The behavior is subtle and central to the review contract.
  Suggested fix: Add one test that proves invalid line targets fall back to the top-level review body.

## Potential Risks
- `[confidence: 60/100]` Retry behavior may still duplicate comments when network errors happen after publish.
  Reasoning: The flow has idempotency checks before publish, but post-publish failure handling is not proven in visible tests.
  Assumptions: Publish call can succeed remotely before client timeout.
  Suggested mitigation: Add one integration test that simulates timeout-after-success and verifies de-duplication.

## Evidence Table
| Item | Status | Evidence | Severity if fail |
| --- | --- | --- | --- |
| T-01 Changed logic has tests | FAIL | `src/review/run-review.ts:71` | Critical |
| D-02 Empty values preserved | PASS | `src/review/map-input.ts:33` | Critical |

## Previous Findings Closure
| Previous finding | Status | Evidence |
| --- | --- | --- |
| Missing idempotency guard | Fixed | `src/review/run-review.ts:71` |

## Verdict
- `Block`
- Rationale: One unresolved critical issue remains.

## Missing Validation
- `pnpm test` was not run in this environment.
- Runtime behavior was reviewed statically only.
```

## Decision Rules

- `Block` if any critical finding exists.
- `Needs fixes` if no critical finding exists but at least one major finding exists.
- `Approve with notes` if only minor findings or improvements exist.
- `Approve` if no findings exist and validation is sufficient for the scope.

Potential risks should not independently raise verdict severity without evidence that meets findings thresholds.
