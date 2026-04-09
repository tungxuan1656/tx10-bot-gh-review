# macOS Deployment Checklist

This guide covers the simplest reliable setup for running the GitHub review bot on macOS with:

- `pm2` to keep the Node.js app alive
- `cloudflared` to expose the webhook over HTTPS
- a custom hostname on Cloudflare
- a GitHub App pointing its webhook to that hostname

This setup is suitable for personal use, staging, and light production use. It is not as robust as a Linux server because a Mac can sleep, log out, or be interrupted by OS updates.

## Recommended Topology

- macOS machine that stays online
- Node.js 22 + pnpm
- Codex CLI installed and logged in under the same macOS user that runs PM2
- app listening on `127.0.0.1:43191`
- `cloudflared` exposing `https://bot.example.com` to `http://127.0.0.1:43191`
- GitHub App webhook URL set to `https://bot.example.com/github/webhooks`

## Before You Start

Make sure you have:

- a Mac that can stay awake and connected
- a domain managed by Cloudflare
- a Cloudflare account with Tunnel access
- an OpenAI account that can use Codex CLI
- a GitHub account that can create and install a GitHub App
- this repository cloned locally

## 1. Install Node.js, pnpm, PM2, and Codex CLI

Using Homebrew:

```bash
brew install node
corepack enable
corepack prepare pnpm@10.28.1 --activate
npm install -g pm2 @openai/codex
```

Verify:

```bash
node -v
pnpm -v
pm2 -v
codex --version
```

## 2. Clone and Build the App

```bash
git clone <YOUR_REPO_URL> ~/tx10-bot-gh-review
cd ~/tx10-bot-gh-review
pnpm install --frozen-lockfile
pnpm build
pnpm validate
```

## 3. Log In to Codex CLI

The same macOS user that runs `pm2` must also own the Codex login session.

### Option A: Sign in with ChatGPT

```bash
codex login --device-auth
codex login status
```

### Option B: Use an API Key

```bash
export OPENAI_API_KEY="<YOUR_OPENAI_API_KEY>"
printenv OPENAI_API_KEY | codex login --with-api-key
codex login status
```

Do not continue until `codex login status` shows a valid login.

## 4. Create the Runtime Environment File

Create `~/tx10-bot-gh-review/.env`:

```bash
cat > ~/tx10-bot-gh-review/.env <<'EOF'
PORT=43191
LOG_LEVEL=info
CODEX_BIN=codex
GITHUB_APP_ID=1234567
GITHUB_WEBHOOK_SECRET=replace-with-random-secret
GITHUB_INSTALLATION_ID=
GITHUB_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\nREPLACE_ME\n-----END PRIVATE KEY-----\n'
EOF
```

Notes:

- `GITHUB_WEBHOOK_SECRET` must exactly match the webhook secret configured in the GitHub App
- `GITHUB_PRIVATE_KEY` must be stored as one line with literal `\n`
- `GITHUB_INSTALLATION_ID` is optional

If you have a PEM file and need to convert it to one line:

```bash
python3 - <<'PY'
from pathlib import Path
key = Path("github-app.private-key.pem").read_text().strip()
print(key.replace("\n", "\\n"))
PY
```

## 5. Smoke Test the App Locally

```bash
cd ~/tx10-bot-gh-review
set -a
source .env
set +a
node dist/http/index.js
```

In another shell:

```bash
curl http://127.0.0.1:43191/healthz
```

Expected:

```json
{"status":"ok"}
```

Stop the process after this test.

## 6. Run the App with PM2

Start the app:

```bash
cd ~/tx10-bot-gh-review
set -a
source .env
set +a
pm2 start dist/http/index.js --name gh-review-bot --interpreter node --update-env
```

Confirm it is healthy:

```bash
pm2 status
pm2 logs gh-review-bot
curl http://127.0.0.1:43191/healthz
```

Persist the process list:

```bash
pm2 save
```

If you later change values in `.env`, reload them from a shell that has sourced the file and then run:

```bash
pm2 restart gh-review-bot --update-env
```

## 7. Configure PM2 Startup on macOS

PM2 supports `launchd` on macOS for restoring saved processes at boot.

Generate the startup configuration:

```bash
pm2 startup
```

PM2 will print a command to run. Execute the exact command it gives you, then save again:

```bash
pm2 save
```

After a reboot, check:

```bash
pm2 status
```

If PM2 does not come back after reboot, the usual cause is that the launch agent was not installed correctly or the user session/environment changed.

## 8. Install and Configure Cloudflare Tunnel

Install `cloudflared`:

```bash
brew install cloudflared
cloudflared --version
```

Authenticate with Cloudflare:

```bash
cloudflared tunnel login
```

Create a named tunnel:

```bash
cloudflared tunnel create gh-review-bot
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /Users/<YOUR_MAC_USER>/.cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: bot.example.com
    service: http://127.0.0.1:43191
  - service: http_status:404
```

Validate the config:

```bash
cloudflared tunnel ingress validate
```

Route the hostname to the tunnel:

```bash
cloudflared tunnel route dns gh-review-bot bot.example.com
```

## 9. Run Cloudflare Tunnel as a macOS Service

For a long-running setup, use `cloudflared` as a macOS service instead of keeping it in a shell tab.

Install the service:

```bash
sudo cloudflared service install
```

Start it:

```bash
sudo launchctl start com.cloudflare.cloudflared
```

Useful logs:

```bash
tail -f /Library/Logs/com.cloudflare.cloudflared.out.log
tail -f /Library/Logs/com.cloudflare.cloudflared.err.log
```

Check the public health endpoint:

```bash
curl https://bot.example.com/healthz
```

Expected:

```json
{"status":"ok"}
```

## 10. Configure the GitHub App

In GitHub:

1. Go to **Settings** -> **Developer settings** -> **GitHub Apps**
2. Click **New GitHub App**
3. Set:
   - **Homepage URL**: `https://bot.example.com`
   - **Webhook URL**: `https://bot.example.com/github/webhooks`
   - **Webhook secret**: same value as `GITHUB_WEBHOOK_SECRET`
4. Set repository permissions:
   - **Contents**: Read-only
   - **Pull requests**: Read and write
   - **Issues**: Read and write
5. Subscribe to the **Pull request** event
6. Create the app
7. Generate and download the private key
8. Install the app on the target repository

Why these permissions are needed:

- `Contents` is used to fetch current file content for the PR head SHA
- `Pull requests` is used to list changed files and submit reviews
- `Issues` is used for neutral fallback comments

## 11. End-to-End Verification

Run this checklist in order:

### Local app

- `pm2 status` shows `gh-review-bot` as online
- `curl http://127.0.0.1:43191/healthz` returns `{"status":"ok"}`
- `codex login status` shows a valid login

### Tunnel

- `cloudflared tunnel info gh-review-bot`
- `curl https://bot.example.com/healthz` returns `{"status":"ok"}`

### GitHub App

- open the GitHub App settings page
- inspect **Recent Deliveries**
- trigger a delivery by opening a PR or pushing to an existing PR
- confirm GitHub receives `202 Accepted`
- confirm the PR receives a review or a neutral fallback comment

## 12. Updating the App

When you deploy a new version:

```bash
cd ~/tx10-bot-gh-review
git pull
pnpm install --frozen-lockfile
pnpm build
pnpm validate
pm2 restart gh-review-bot --update-env
pm2 save
```

If you update Codex CLI:

```bash
npm install -g @openai/codex
codex --version
```

## Common Failure Modes

### PM2 is up but reviews fail

- `codex login status` is invalid
- the app is running as a different macOS user than the one that authenticated Codex
- `CODEX_BIN` does not resolve to `codex`

### Tunnel is up but GitHub webhook delivery fails

- the public hostname was not routed to the named tunnel
- the GitHub webhook URL does not exactly match `/github/webhooks`
- the GitHub App webhook secret does not match `GITHUB_WEBHOOK_SECRET`

### Public health check works but webhook returns `401`

- Cloudflare is forwarding correctly, but the webhook secret is wrong
- a proxy or middleware changed the raw request body before verification

### Everything looks correct but the bot stops after a while

- the Mac went to sleep
- the user session changed
- `cloudflared` service or PM2 startup was not persisted correctly

## Operational Notes

- Do not use a Quick Tunnel URL for GitHub App webhooks. Use a named tunnel plus a stable hostname.
- Do not protect the webhook hostname with Cloudflare Access. GitHub must be able to post to it directly.
- Keep the Mac awake if you expect the bot to run continuously.
- This setup is operationally simpler than a Linux server, but less reliable for true 24/7 use.

## Useful References

- [PM2 startup hook](https://doc.pm2.io/en/runtime/guide/startup-hook/)
- [PM2 startup on macOS / launchd support](https://pm2.keymetrics.io/docs/usage/startup/)
- [Cloudflare Tunnel overview](https://developers.cloudflare.com/tunnel/)
- [Install cloudflared on macOS](https://developers.cloudflare.com/tunnel/downloads/)
- [Run cloudflared as a service on macOS](https://developers.cloudflare.com/tunnel/advanced/local-management/as-a-service/macos/)
- [Cloudflare Tunnel configuration file](https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/)
- [Published applications with Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/routing-to-tunnel/)
- [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)
