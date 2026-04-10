# Reference Skills

Select the smallest set of repo-local review skills that materially tightens the review. In the final review, cite only the skill names, not file paths.

## Baseline

- `coding-standards`
  - Use for readability, naming, simplicity, maintainability, and code hygiene.

## TypeScript and JavaScript

- `typescript-reviewer`
  - Use for `.ts`, `.tsx`, `.js`, `.jsx`, type safety, async correctness, Node or web security, and build-tooling changes.

## Backend and API

- `api-design`
  - Use for API routes, contracts, status codes, pagination, filtering, and rate limiting.
- `security-review`
  - Use for authentication, authorization, secrets, input validation, external calls, write paths, uploads, or sensitive data handling.
- `database-reviewer`
  - Use for SQL, migrations, query builders, indexes, transactions, constraints, and connection behavior.

## Frontend and UI

- `frontend-patterns`
  - Use for React components, hooks, forms, state, rendering, routing, or client data fetching.
- `react-component-performance`
  - Use for expensive render paths, large lists, derived data, timers, memoization, or rerender hotspots.
- `i18n-localization`
  - Use for user-facing copy, locale keys, translations, formatting, runtime locale switching, or hardcoded text risks.
- `tailwind-patterns`
  - Use for Tailwind setup, theme tokens, utility usage, or CSS-first configuration changes.
- `tailwind-design-system`
  - Use for shared UI primitives, visual consistency, design tokens, and component styling conventions.

## Mobile

- `react-native-architecture`
  - Use for Expo, React Native navigation, offline flows, native modules, and mobile state architecture.
- `mobile-security-coder`
  - Use for WebView, secure storage, credentials, mobile secrets, and platform-specific security behavior.

## Selection Rules

- Start with `coding-standards` when maintainability and readability are part of the review scope.
- Add only the domain skills that match the changed code path.
- If two skills overlap, keep both only when they contribute different checks.
- If no repo-local skill meaningfully applies, say `None` in `Reference Skills`.
