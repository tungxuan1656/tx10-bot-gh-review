# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Project Direction

This repository is a pnpm monorepo for a multi-source novel crawler built with Node.js and TypeScript.

The system is intentionally split into:

- a local crawler/export runtime
- a Supabase export registry

## Architecture

### Local runtime

- lives in `crawler`
- crawls source sites
- stores crawled books and chapters in local SQLite
- builds ZIP archives locally
- uploads ZIP files to Supabase Storage
- upserts exported-book metadata into Supabase

### Supabase

- lives in `supabase`
- stores only export-facing metadata
- exposes read-only Edge Functions
- is not the source of truth for crawled chapter content

## Identity Rules

- `books.id` is the canonical Supabase book ID
- `books.source` identifies the crawler source
- `books.slug` stores the source-local story slug
- `exported_books.book_id` must reference canonical `books.id`

New flows must resolve books by `(source, slug)`.

## Project Rules

1. Local SQLite is the source of truth for crawl data.
2. Supabase is an export registry and read API layer only.
3. New write flows belong in the local runtime, not in Supabase Edge Functions.
4. Node.js workspace packages should use `@supabase/supabase-js`.
5. Supabase Edge Functions should keep Deno-compatible imports.
6. Schema, functions, and docs must stay aligned in the same change set.

## Monorepo Guidance

- keep runnable projects at the top level as `crawler/` and `supabase/`
- introduce shared code only when reuse becomes real
- keep Supabase migrations and Edge Functions isolated under `supabase/`
- prefer small, explicit workspace boundaries over premature shared packages
