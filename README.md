# Stardance Hardware Review Queue

A Slack bot that watches your `#hardware-review` (or whatever channel you point it at), parses the review bot's "new design submission" and "review returned" messages, stores everything in a local SQLite database, and serves a live dashboard.

## 1. Create the Slack app

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**.
2. Name it (e.g. "Review Queue Tracker"), pick your workspace.
3. **Socket Mode**: under *Settings → Socket Mode*, turn it on. This generates an **App-Level Token** (`xapp-...`) — copy it, it's `SLACK_APP_TOKEN`. Give it the `connections:write` scope when prompted.
4. **OAuth & Permissions** → add these **Bot Token Scopes**:
   - `channels:history` (read past messages in public channels)
   - `groups:history` (only if the channel is private)
   - `channels:read`
   - `users:read` (to resolve `@mentions` to names)
5. **Event Subscriptions**: turn on, subscribe to bot events: `message.channels` (and `message.groups` if private).
6. **Install App to Workspace** → copy the **Bot User OAuth Token** (`xoxb-...`) → that's `SLACK_BOT_TOKEN`. Copy the **Signing Secret** from *Basic Information* too.
7. In Slack, go to the target channel and `/invite @YourBotName`.
8. Get the channel ID: right-click the channel name → *View channel details* → scroll down → copy the ID (looks like `C0123ABC456`).

## 2. Configure

```bash
cp .env.example .env
# fill in SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_APP_TOKEN, SLACK_CHANNEL_ID
```

## 3. Run it

### Option A — Docker (recommended)

```bash
docker compose up -d --build
```

This builds the image, starts the bot + dashboard, and stores the SQLite database in a named volume (`queue-data`) that survives restarts and rebuilds. Open http://localhost:3000.

To run the one-time backfill (import everything posted before the bot joined) inside the running container:

```bash
docker compose exec review-queue node src/backfill.js
```

Useful commands:

```bash
docker compose logs -f          # watch bot activity / parse errors live
docker compose restart          # apply a code change (rebuild first: docker compose up -d --build)
docker compose down             # stop (data volume is untouched)
docker compose down -v          # stop AND wipe the database
```

### Option B — Node directly

```bash
npm install
npm run backfill   # imports everything already posted in the channel (one-time)
npm start           # starts the bot + dashboard server
```

Open http://localhost:3000 — the dashboard polls `/api/queue` and `/api/log` every 15s, so new Slack activity shows up automatically without a refresh.

## How parsing works

`src/parser.js` matches two message shapes via regex — the "new design submission!" post and the "brand new design review!! ... returned:" post. If your review bot's message format ever changes, that's the one file to update. Messages that don't match either shape are logged and skipped rather than guessed at.

## Data model

- `projects` — one row per unique (name, author) pair.
- `events` — every submission/review event, linked to a project, timestamped from the original Slack message (`slack_ts`), so re-running the backfill never creates duplicates.

Status per project is derived from its most recent event (`src/status.js`):
- **Awaiting First Review** — only ever submitted once, never reviewed.
- **Needs Changes** — most recent event is a review that requested changes.
- **Resubmitted — Awaiting Re-Review** — was sent back, then resubmitted.

## Deploying somewhere persistent

Socket Mode means you don't need a public URL, so the container runs fine on any always-on host: a small VPS, a Raspberry Pi, or a platform that runs arbitrary Docker images (Railway, Render, Fly.io, etc — point them at this repo/Dockerfile and set the same env vars in their dashboard instead of a `.env` file). SQLite's `data/queue.db` is the only state; back up the `queue-data` volume, or swap in Postgres later if you outgrow it.

To back up the database:

```bash
docker compose exec review-queue cat /app/data/queue.db > backup.db
```
