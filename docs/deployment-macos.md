# macOS Deployment Checklist

This guide covers the simplest reliable macOS setup for the review bot using:

- `pm2` to keep the Node.js app alive
- `cloudflared` to expose the webhook over HTTPS
- a dedicated GitHub machine user for review publishing

This setup is suitable for personal use, staging, and light production use. It is less robust than a Linux server because a Mac can sleep, log out, or be interrupted by OS updates.

## Recommended Topology

- macOS machine that stays online
- Node.js 22 + pnpm
- Codex CLI installed and logged in under the same macOS user that runs PM2
- app listening on `127.0.0.1:43191`
- `cloudflared` exposing `https://bot.example.com` to `http://127.0.0.1:43191`
- repository or organization webhook set to `https://bot.example.com/github/webhooks`

## Before You Start

Make sure you have:

- a Mac that can stay awake and connected
- a domain managed by Cloudflare
- a Cloudflare account with Tunnel access
- an OpenAI account that can use Codex CLI
- a dedicated GitHub account that will act as the reviewer bot
- a token for that account
- this repository cloned locally

## 1. Install Node.js, pnpm, PM2, and Codex CLI

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

```bash
codex login --device-auth
codex login status
```

Or:

```bash
export OPENAI_API_KEY="<YOUR_OPENAI_API_KEY>"
printenv OPENAI_API_KEY | codex login --with-api-key
codex login status
```

## 4. Create the Runtime Environment File

Create `~/tx10-bot-gh-review/.env`:

```bash
cat > ~/tx10-bot-gh-review/.env <<'EOF'
PORT=43191
LOG_LEVEL=info
CODEX_BIN=codex
GITHUB_TOKEN=ghp_replace_me
GITHUB_BOT_LOGIN=review-bot
GITHUB_WEBHOOK_SECRET=replace-with-random-secret
EOF
```

Notes:

- `GITHUB_TOKEN` belongs to the machine user.
- `GITHUB_BOT_LOGIN` must exactly match the reviewer account login.
- `GITHUB_WEBHOOK_SECRET` must match the repository or organization webhook secret.

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

## 6. Run the App with PM2

```bash
cd ~/tx10-bot-gh-review
set -a
source .env
set +a
pm2 start dist/http/index.js --name gh-review-bot --interpreter node --update-env
pm2 save
pm2 status
pm2 logs gh-review-bot
```

If you later change `.env`, source it again and restart:

```bash
pm2 restart gh-review-bot --update-env
```

## 7. Configure PM2 Startup on macOS

```bash
pm2 startup
pm2 save
```

After a reboot, confirm:

```bash
pm2 status
```

## 8. Install and Configure Cloudflare Tunnel

```bash
brew install cloudflared
cloudflared tunnel login
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

Then:

```bash
cloudflared tunnel ingress validate
cloudflared tunnel route dns gh-review-bot bot.example.com
sudo cloudflared service install
sudo launchctl start com.cloudflare.cloudflared
```

## 9. Configure the GitHub Side

1. Add the machine user to the repository or organization with review access.
2. Create a repository or organization webhook to `https://bot.example.com/github/webhooks`.
3. Enable the `Pull requests` event.
4. Set the webhook secret to the same value as `GITHUB_WEBHOOK_SECRET`.

Behavior notes:

- The bot only runs when the machine user is explicitly requested as a reviewer.
- Pushing a new commit does not auto-trigger another review.
- Ask GitHub to request review from the bot account again when you want a new pass.

## Troubleshooting

### Tunnel is healthy but GitHub cannot deliver the webhook

- Confirm the hostname exactly matches `/github/webhooks`.
- Confirm the webhook secret matches `GITHUB_WEBHOOK_SECRET`.
- Do not protect the webhook route with an interactive auth layer.

### The bot never comments after being requested

- Confirm `GITHUB_BOT_LOGIN` matches the reviewer login in GitHub.
- Confirm the machine user token still has enough permissions to read pull requests and create reviews.
