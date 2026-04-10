---
name: code-review
description: Rigorous, evidence-driven code review for diffs, commits, and pull requests. Produce a concise change summary first, then findings grouped as critical, major, minor, and improvement with explicit confidence scores, evidence, suggested fixes, decision, and validation gaps. Use when reviewing correctness, regression risk, security, data integrity, performance, testing, maintainability, or follow-up fixes. Select and cite the relevant repo-local review skills by name, such as api-design, coding-standards, database-reviewer, frontend-patterns, security-review, and typescript-reviewer, to tighten domain-specific checks.
---

# Code Review

## Overview

Perform strict, low-noise reviews that are summary-first, evidence-backed, and domain-aware. Treat review as a reproducible inspection workflow, not a stream of impressions.

## Required Inputs

- Review target: staged diff, working-tree diff, commit, or pull request.
- Scope anchor: base/head refs, PR number, or recent commit when no diff is available.
- Changed files and the surrounding code required to understand impact.
- Available validation signals such as lint, typecheck, tests, CI, or reproducible commands.
- Optional project-specific constraints when the changed area has special conventions.

## Required Outputs

- `Change Summary`
- `Reference Skills`
- `Findings` grouped by severity
- `Evidence Table`
- `Verdict`
- `Missing Validation`
- `Previous Findings Closure` when the review is for a follow-up fix

## Review Setup

Load these references at the start of each review:

1. [references/review-playbook.md](references/review-playbook.md)
2. [references/reference-skills.md](references/reference-skills.md)
3. [references/rule-catalog.md](references/rule-catalog.md)
4. [references/severity-confidence-rubric.md](references/severity-confidence-rubric.md)
5. [references/output-contract.md](references/output-contract.md)

## Core Workflow

1. Establish the real review scope.
   - Prefer `git diff --staged`, `git diff`, or PR metadata plus PR diff.
   - Use the actual PR base branch or merge base when available. Do not hard-code `main`.
   - If no diff is available, inspect the most relevant recent commit and state that the scope is degraded.
2. Run the narrowest relevant validation commands when practical.
   - Prefer the repository's canonical commands for lint, typecheck, test, or validate.
   - If checks are skipped, blocked, or unavailable, say so in `Missing Validation`.
3. Select `Reference Skills` by name.
   - Use `reference-skills.md` to choose the smallest set of repo-local skills that materially improve the review.
   - In the final review, cite only the skill names, not file paths.
4. Read the full changed files and the necessary surrounding context.
   - Read tests, imports, callers, contracts, and adjacent modules when they affect behavior.
   - Do not review hunks in isolation.
5. Build the change summary before looking for issues.
   - Identify affected flows, trust boundaries, data paths, and the highest regression risks.
6. Apply the rule catalog and high-value probes.
   - Use the rules to inspect correctness, security, data integrity, lifecycle, performance, testing, maintainability, accessibility, and hygiene.
7. Score each potential issue using severity and confidence.
   - Report only evidence-backed findings that meet the minimum confidence threshold for their severity.
8. Write the review using the output contract.
   - Summary first.
   - Findings second.
   - Verdict and missing validation last.

## Review Principles

- Evidence first. No evidence means no finding.
- Report only issues that are likely real and actionable.
- Prefer one representative finding over repetitive noise.
- Review changed code first. Only reach into unchanged code when it is directly implicated or exposes a critical issue.
- Favor behavioral risk over stylistic preference.
- Keep the review strict, but avoid vague or speculative comments.

## Adaptation Rules

- Use the skill playbook as the default review standard.
- If the repository exposes stronger local conventions, apply them in addition to this skill rather than replacing the baseline.
- If a required artifact is missing, continue with the strongest available evidence and state the gap explicitly.
- If a follow-up patch claims to fix prior findings, require explicit closure verification instead of assuming resolution.
