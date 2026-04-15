# Severity and Confidence Rubric

Use this rubric to keep reviews strict, reproducible, and low-noise.

## Severity Levels

### Critical

Use for issues with immediate merge-blocking impact:

- security or privacy breach
- broken primary flow or guaranteed wrong behavior
- data loss, corruption, or irreversible side effect
- missing auth or permission guard on a sensitive path
- clear regression against a mandatory rule

Default verdict impact: `Block`

### Major

Use for high-signal defects that should be fixed before merge:

- likely behavioral regression
- incorrect state ownership or contract mapping
- concurrency, lifecycle, retry, or idempotency bug
- missing validation with material risk
- substantial missing test coverage on changed logic
- performance issue with clear user or operational cost

Default verdict impact: `Needs fixes`

### Minor

Use for lower-risk defects or maintainability problems that still warrant action:

- constrained edge-case bug
- confusing logic that can hide future bugs
- local convention break with limited impact
- non-critical but real hygiene issue

Default verdict impact: `Approve with notes`

### Improvement

Use for concrete, non-blocking suggestions:

- stronger regression tests around subtle logic
- simpler structure with clear future payoff
- safer naming, comments, or guard rails
- proactive cleanup that reduces future review risk

Default verdict impact: `Approve with notes`

## Confidence Scale

Attach `confidence: NN/100` to every reported item.

### 90-100

Direct, deterministic evidence. Little to no inference required.

### 80-89

Strong evidence with limited inference. Appropriate for most major issues.

### 70-79

Bounded, lower-risk findings or improvements. Use sparingly.

### Below 60

Do not report. Convert to an open question or omit.

## Minimum Reporting Thresholds

- `critical` requires `90+`
- `major` requires `80+`
- `minor` requires `65+`
- `improvement` requires `60+`

## Scoring Rules

- Lower confidence when surrounding context (callers, contracts, adjacent tests) is absent from the provided files. Static analysis without test execution is the assumed baseline; do not apply an additional penalty solely for lack of runtime verification.
- Prefer one representative finding over multiple low-confidence duplicates. When the same pattern recurs, report a primary finding and list all affected locations.
- If the issue depends on an assumption that cannot be verified from the code or available evidence, do not report it as a finding.
- If a bug is reproducible through a direct code path trace, confidence should usually be `90+`.
- For minor and improvement findings, prefer reporting over silence. A finding with borderline confidence and real evidence is better than a silent omission.