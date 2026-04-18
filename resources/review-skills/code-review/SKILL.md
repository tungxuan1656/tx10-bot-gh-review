---
name: code-review
description: Rigorous, evidence-driven and depth-oriented code review system. Combines rule-based validation, coverage guarantees, and adversarial analysis to detect both explicit defects and subtle risks.
---

# Code Review v4

## Overview

Perform strict, low-noise, and high-signal reviews using:

- Evidence-based validation (core)
- Coverage guarantees (dimensions)
- Adversarial reasoning (attack mode)
- Risk surfacing (potential risks)

This is a multi-layer inspection system, not a simple checklist.

## Required Outputs

- Change Summary
- Reference Skills
- Findings (high-confidence only)
- Potential Risks (lower-confidence insights)
- Evidence Table
- Previous Findings Closure (if applicable)
- Verdict
- Missing Validation

## Section Order

1. Change Summary
2. Reference Skills
3. Findings
4. Potential Risks
5. Evidence Table
6. Previous Findings Closure
7. Verdict
8. Missing Validation

## Review Setup

Load these references at the start of each review:

1. [references/review-playbook.md](references/review-playbook.md)
2. [references/reference-skills.md](references/reference-skills.md)
3. [references/rule-catalog.md](references/rule-catalog.md)
4. [references/severity-confidence-rubric.md](references/severity-confidence-rubric.md)
5. [references/output-contract.md](references/output-contract.md)

## Core Workflow

### Phase 1: Scope & Context

- Identify review target (diff / PR / commit)
- Determine base/head correctly
- List changed files and affected flows
- Identify high-risk areas:
  - input handling
  - async / concurrency
  - state ownership
  - contracts / mapping
  - auth / permissions

### Phase 2: Validation Signals

- Check available signals (CI, tests, lint)
- Do NOT assume they passed
- Note missing signals later

### Phase 3: Full Context Reading

- Read full files (not just diff)
- Read:
  - call sites
  - imports
  - tests
  - adjacent modules

### Phase 4: Change Summary (MANDATORY FIRST)

Summarize:

- what changed
- affected flows
- trust boundaries
- highest regression risks

### Phase 5: Rule-Based Review (Evidence Pass)

Apply rule catalog:

- correctness & behavior
- security & privacy
- data integrity
- lifecycle & concurrency
- performance
- architecture
- tests
- type safety
- i18n / accessibility
- hygiene

Rules:

- Every finding MUST have evidence (file:line)
- No vague or speculative findings
- Only report above confidence threshold

## Review Dimensions (Coverage Guard)

Ensure ALL dimensions are evaluated:

- Correctness & Logic
- Edge Cases & Failure Modes
- Security & Privacy
- Performance & Scalability
- Data Integrity & Contracts
- Concurrency & Lifecycle
- Code Quality & Maintainability
- Consistency with Codebase
- UX / User Flow (if applicable)

Rules:

- Do not skip any dimension
- Do not use generic statements ("looks fine")
- Each dimension must be consciously checked

## Attack Mode (Break-the-Code Pass)

After evidence-based review, perform a second pass:

Assume the code is fragile or incorrect.

Focus on:

- invalid / unexpected inputs
- race conditions
- retries / duplication
- async ordering issues
- partial / corrupted data

Requirements:

- Identify at least 3 failure scenarios
- Each must include:
  - trigger
  - failure behavior
  - impacted flow

This complements (not replaces) evidence findings.

## UX / User Flow Review (When Applicable)

For user-facing code:

Check:

### Loading States

- async operations have visible feedback

### Error Handling

- errors are visible and actionable
- no sensitive leakage

### User Actions

- buttons reflect real system state
- disabled/loading states correct

### Feedback

- success/failure clearly communicated
- retry/recovery exists

### Consistency

- matches existing UI patterns

## Findings

Report only high-confidence issues.

### Severity Levels

- Critical
- Major
- Minor
- Improvement

Requirements per finding:

- confidence score
- evidence (file:line)
- issue description
- why it matters
- suggested fix

## Potential Risks (Lower Confidence)

List meaningful concerns that lack full certainty.

Rules:

- Confidence: 60-79
- Must include reasoning grounded in code
- Clearly state assumptions
- DO NOT mix with Findings

Format:

- [confidence: 72/100] Risk description
  Reasoning: ...
  Suggested mitigation: ...

## Minimum Insight Rule

Prevent shallow reviews:

- Must include:
  - at least 1 Improvement OR
  - at least 1 Potential Risk

If no issues found:

- Explicitly justify safety
- Confirm edge cases, failure modes, and regressions checked

## Evidence Table

| Item | Status | Evidence | Severity if fail |
|------|--------|----------|------------------|

## Previous Findings Closure (if applicable)

| Previous finding | Status | Evidence |
|------------------|--------|----------|

## Verdict Rules

- Block -> any Critical
- Needs fixes -> Major present
- Approve with notes -> Minor/Improvement only
- Approve -> no findings

## Missing Validation

Explicitly list:

- skipped tests
- unavailable CI
- assumptions made

## Review Principles

- Evidence first
- No evidence -> no finding
- Prefer signal over noise
- Review behavior, not just syntax
- Read full context
- Do not trust "looks correct"
- Always consider failure modes

## System Layers (Mental Model)

This review system operates in 4 layers:

1. Rule-based detection -> real bugs
2. Dimensions -> no blind spots
3. Attack mode -> hidden failures
4. Risk layer -> uncertain but important signals

All layers must work together.
