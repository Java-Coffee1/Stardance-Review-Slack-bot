require("dotenv").config();
const path = require("path");
const express = require("express");
const { App } = require("@slack/bolt");
const {
  findOrCreateProject,
  insertEvent,
  getAllProjectsWithEvents,
  getAllEventsChronological,
} = require("./db");
const { parseMessage, resolveMention } = require("./parser");
const { computeStatus, STATUS_LABEL } = require("./status");

const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

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
  const author = await resolveMention(parsed.authorRaw, client);

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
    const reviewer = await resolveMention(parsed.reviewerRaw, client);
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
  const projects = getAllProjectsWithEvents().map((p) => {
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
  res.json({ projects });
});

web.get("/api/log", (req, res) => {
  res.json({ events: getAllEventsChronological() });
});

const PORT = process.env.PORT || 3000;
web.listen(PORT, () => console.log(`Dashboard + API on http://localhost:${PORT}`));

(async () => {
  await slackApp.start();
  console.log("⚡️ Stardance review bot is listening on Slack (Socket Mode)");
})();
