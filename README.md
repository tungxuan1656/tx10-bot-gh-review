# AI Code Review Bot

AI Code Review Bot is a machine-user GitHub reviewer powered by Codex CLI. It receives repository or organization pull request webhooks, routes all review work through a single global FIFO queue, materializes each pull request into a temporary git workspace, instructs Codex to inspect the `baseSha...headSha` PR diff (merge-base to head) directly via git commands inside that workspace, and publishes one GitHub review per accepted manual review request.

## MVP Scope

- Repository or organization webhook ingestion
- Single global FIFO queue for all repositories and pull requests
- Diff filtering for `.js`, `.jsx`, `.ts`, `.tsx`, `.py`, and `.java`
- Temporary git workspace checkout at the webhook `headSha`
- Review skill bundle injection from `resources/review-skills/*` into the temp workspace `.agents/skills`
- Pull request discussion context fetch (GraphQL-first, REST fallback) persisted as `pr-review-comments.md` and referenced by the prompt for in-workspace reading
- Codex CLI invocation in the temporary workspace with a strict JSON output contract and completion gate (completed turn, successful full diff inspection, and `reviewStatus=complete`)
- Initial review flow with 2 phases (metadata summary, then deep JSON review)
- Re-review flow with 1 fast JSON phase focused on delta since the latest successful bot-reviewed SHA
- Deterministic GitHub review publishing:
- `REQUEST_CHANGES` for `critical` or `major`
- `APPROVE` for `minor`, `improvement`, or no findings
- `APPROVE` may still include inline comments or summary findings for non-blocking issues
- PR reactions mirror review state: `eyes` while actively reviewing, `hooray` on `APPROVE`, `confused` on `REQUEST_CHANGES`, and `laugh` for ignored requests that do not get reviewed.
- `approved_before`, `review_request_removed`, and review failures are reaction no-ops.
- Review starts only on `review_requested` for the configured bot
- `synchronize` events are ignored and never auto-trigger review
- Optional approved lock: after bot `APPROVE`, repeat requests for that head SHA are ignored with reason `approved_before`; new commits remain reviewable by manual request

## Project Layout

- `src/http` contains the Express server, `/github/webhooks`, and `/healthz`
- `src/review` contains file filtering, prompt assembly, Codex invocation, decision logic, and GitHub publishing
- `docs` contains architecture, prompt contract, and operational runbooks
- `test` contains unit and integration coverage for the MVP seams

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `GITHUB_TOKEN` | Yes | Fine-grained PAT or classic PAT for the machine user |
| `GITHUB_BOT_LOGIN` | Yes | Exact GitHub login of the machine user reviewer |
| `GITHUB_WEBHOOK_SECRET` | Yes | Shared secret used to verify repository or organization webhooks |
| `CODEX_BIN` | No | Codex CLI binary path. Defaults to `codex`. |
| `CODEX_MODEL` | No | Codex model passed as `--model`. Defaults to `gpt-5.3-codex`. |
| `CODEX_TIMEOUT_MS` | No | Max review runtime per Codex invocation in milliseconds. Defaults to `900000` (15 minutes). |
| `REVIEW_APPROVED_LOCK_ENABLED` | No | When `true`, repeat requests for the same approved head SHA are ignored with reason `approved_before`. New head SHAs can still be reviewed by manual request. Defaults to `true`. |
| `REVIEW_DISCUSSION_CACHE_DIR` | No | Directory for cached PR discussion markdown snapshots. Defaults to a temp directory. |
| `REVIEW_DISCUSSION_CACHE_TTL_MS` | No | TTL for cached discussion snapshots in milliseconds. Defaults to `604800000` (7 days). |
| `LOG_LEVEL` | No | Pino log level. Defaults to `info`. |
| `LOG_PRETTY` | No | Pretty-print logs (`auto`, `true`, or `false`). Defaults to `auto` (enabled in development TTY). |
| `PORT` | No | HTTP port. Defaults to `43191`. |

## Local Development

1. Install dependencies with `pnpm install`.
2. Export the required environment variables.
3. Start the server with `pnpm dev`.
4. Expose the local webhook endpoint with a tunnel such as `ngrok`:
   - `POST /github/webhooks`
   - `GET /healthz`

## GitHub Setup

1. Create a dedicated GitHub account that will act as the reviewer bot.
2. Add that account to the target repository or organization with enough access to read pull requests and submit reviews.
3. Generate a token for that account and export it as `GITHUB_TOKEN`.
4. Configure a repository or organization webhook that points at `/github/webhooks`.
5. Set the webhook secret to the same value used in `GITHUB_WEBHOOK_SECRET`.
6. Make sure pull request events are enabled in the webhook configuration.

## Validation

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm docs:lint`
- `pnpm docs:check-links`
- `pnpm validate`

## Deployment

For macOS, use PM2 with Cloudflare Tunnel as described in the deployment guide. For Linux, use a small server running the app with `systemd` behind `nginx`. Build with `pnpm build`; the runtime entrypoint is `dist/src/http/index.js` (`pnpm start`). Keep `resources/review-skills/` beside `dist/` in the deployed checkout. The service is intentionally stateless; idempotency is enforced by checking for an existing marker on the current PR run token before publishing a new result after the bot account is requested for review.

Codex uses a read-only sandbox and a restricted child environment. GitHub credentials are passed only to Git fetches and are not stored in workspace remotes. This reduces exposure but is not host-level filesystem isolation; run under a dedicated account with limited access to sensitive files.

Codex must support `exec --json` with command-execution and turn-completion events. Missing evidence, incomplete/blocked output, or truncated diffs produce a neutral failure comment, not an approval. See the [Review Contract](docs/review-contract.md) for the completion gate and large-diff limitation.

Codex reviews are allowed to run for up to 15 minutes by default so larger pull requests have enough time to complete. If needed, tune this with `CODEX_TIMEOUT_MS`.

## Further Reading

- [Architecture](docs/architecture.md)
- [Deployment Guide](docs/deployment.md)
- [macOS + PM2 + Cloudflare Tunnel Guide](docs/deployment-macos.md)
- [Review Contract](docs/review-contract.md)
- [Runbook](docs/runbook.md)
