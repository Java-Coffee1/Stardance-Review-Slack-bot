require("dotenv").config();
const path = require("path");
const express = require("express");
const { App } = require("@slack/bolt");
const {
  findOrCreateProject,
  insertEvent,
  getAllProjectsWithEvents,
  getAllEventsChronological,
  hasAnyEvents,
} = require("./db");
const { parseMessage, resolveMention } = require("./parser");
const { computeStatus, STATUS_LABEL } = require("./status");
const { computeAvgResponseTimeMs, formatDuration } = require("./stats");
const { runBackfill } = require("./backfill");

const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

// Cache resolved @mentions so repeat authors/reviewers don't cost an extra
// users.info call every single message.
const mentionCache = new Map();
async function resolveCached(raw, client) {
  if (mentionCache.has(raw)) return mentionCache.get(raw);
  const resolved = await resolveMention(raw, client);
  mentionCache.set(raw, resolved);
  return resolved;
}

// ---------- Slack bot (Socket Mode: no public URL needed) ----------
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

slackApp.event("message", async ({ event, client }) => {
  // Only watch the configured channel, and skip edits/deletes/bot-of-itself loops.
  if (CHANNEL_ID && event.channel !== CHANNEL_ID) return;
  if (event.subtype && event.subtype !== "bot_message") return;
  if (!event.text) return;

  const parsed = parseMessage(event.text);
  if (!parsed) {
    console.log(`[skip] message didn't match known patterns (ts=${event.ts})`);
    return;
  }

  const occurredAt = new Date(Number(event.ts) * 1000).toISOString();
  const author = await resolveCached(parsed.authorRaw, client);

  const projectId = findOrCreateProject({
    name: parsed.name,
    author,
    githubUrl: parsed.type === "new_submission" ? parsed.githubUrl : null,
    occurredAt,
  });

  if (parsed.type === "new_submission") {
    insertEvent({
      projectId,
      type: "new_submission",
      slackTs: event.ts,
      occurredAt,
      rawText: event.text,
    });
    console.log(`[+] new submission: ${parsed.name} (${author})`);
  } else {
    const reviewer = await resolveCached(parsed.reviewerRaw, client);
    insertEvent({
      projectId,
      type: "review_returned",
      reviewer,
      feedback: parsed.feedback,
      slackTs: event.ts,
      occurredAt,
      rawText: event.text,
    });
    console.log(`[+] review returned: ${parsed.name} by ${reviewer}`);
  }
});

// ---------- Web server: API + dashboard ----------
const web = express();
web.use(express.static(path.join(__dirname, "..", "public")));

web.get("/api/queue", (req, res) => {
  const raw = getAllProjectsWithEvents();
  const projects = raw.map((p) => {
    const status = computeStatus(p.events);
    return {
      id: p.id,
      name: p.name,
      author: p.author,
      githubUrl: p.github_url,
      status,
      statusLabel: STATUS_LABEL[status],
      firstSubmittedAt: p.events[0]?.occurred_at,
      lastActivityAt: p.events[p.events.length - 1]?.occurred_at,
      events: p.events,
    };
  });
  const avgResponseTimeMs = computeAvgResponseTimeMs(raw);
  res.json({
    projects,
    avgResponseTimeMs,
    avgResponseTimeLabel: formatDuration(avgResponseTimeMs),
  });
});

web.get("/api/log", (req, res) => {
  res.json({ events: getAllEventsChronological() });
});

const PORT = process.env.PORT || 3000;
web.listen(PORT, () => console.log(`Dashboard + API on http://localhost:${PORT}`));

(async () => {
  // First run (or a wiped database): automatically pull in the channel's
  // existing history before going live, so the dashboard isn't empty and
  // the queue reflects reality from the start. Runs once — subsequent
  // restarts skip this because the database already has events in it.
  if (!hasAnyEvents()) {
    console.log("No existing data found — running automatic backfill before going live...");
    try {
      await runBackfill();
    } catch (err) {
      console.error("Automatic backfill failed (will still start normally, listening for new messages):", err.message);
    }
  }

  await slackApp.start();
  console.log("⚡️ Stardance review bot is listening on Slack (Socket Mode)");
})();