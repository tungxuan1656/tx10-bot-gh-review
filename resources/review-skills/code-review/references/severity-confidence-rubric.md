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

### Below 70

Do not report as a finding by default. Convert it into an open question or omit it.

## Minimum Reporting Thresholds

- `critical` requires `90+`
- `major` requires `80+`
- `minor` requires `75+`
- `improvement` requires `70+`

## Scoring Rules

- Lower confidence when runtime verification, validation commands, or surrounding context are missing.
- Prefer one representative finding over multiple low-confidence duplicates.
- If the issue depends on an assumption that cannot be verified from the code or available evidence, do not report it as a finding.
- If a bug is reproducible through a direct code path trace or failing command, confidence should usually be `90+`.
