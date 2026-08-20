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
const { isFromReviewBot } = require("./trust");
const { computeStatus, STATUS_LABEL } = require("./status");
const { computeAvgResponseTimeMs, computeRecentThroughputPerHour, estimateWaitMs, formatDuration } = require("./stats");
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
  if (!isFromReviewBot(event)) {
    console.log(`[skip] message in-channel but not from the review bot (bot_id=${event.bot_id || "none"}, ts=${event.ts})`);
    return;
  }

  try {
    const parsed = parseMessage(event.text);
    if (!parsed) {
      console.log(`[skip] message didn't match known patterns (ts=${event.ts})`);
      return;
    }

    if (!parsed.projectUrl) {
      console.warn(`[skip] parsed message but got no projectUrl (ts=${event.ts})\n  text: ${event.text}`);
      return;
    }

    const occurredAt = new Date(Number(event.ts) * 1000).toISOString();
    const author = await resolveCached(parsed.authorRaw, client);

    const projectId = findOrCreateProject({
      projectUrl: parsed.projectUrl,
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
      // review_returned or approved — both carry reviewer + feedback
      const reviewer = await resolveCached(parsed.reviewerRaw, client);
      insertEvent({
        projectId,
        type: parsed.type,
        reviewer,
        feedback: parsed.feedback,
        slackTs: event.ts,
        occurredAt,
        rawText: event.text,
      });
      console.log(`[+] ${parsed.type}: ${parsed.name} by ${reviewer}`);
    }
  } catch (err) {
    console.error(`[error] failed to process message (ts=${event.ts}): ${err.message}\n  text: ${event.text}`);
  }
});

// ---------- Web server: API + dashboard ----------
const web = express();
web.use(express.static(path.join(__dirname, "..", "public")));

function buildEnrichedProjects() {
  const raw = getAllProjectsWithEvents();
  const projects = raw.map((p) => {
    const status = computeStatus(p.events);
    return {
      id: p.id,
      projectUrl: p.project_url,
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
  return { raw, projects };
}

// Attaches queue-position + ETA fields to every project.
// - "needs": ball's in the submitter's court, not the reviewers', until
//   they resubmit — no ETA.
// - "approved": done, nothing to wait for.
// - "awaiting" / "resub": gets a real queue-position-based ETA.
function attachEtaFields(projects, throughputPerHour) {
  return projects.map((match) => {
    if (match.status === "needs") {
      return {
        ...match,
        positionAhead: null,
        groupSize: null,
        etaMs: null,
        etaLabel: null,
        etaNote: "Waiting on a resubmission before it can be reviewed again.",
      };
    }
    if (match.status === "approved") {
      return {
        ...match,
        positionAhead: null,
        groupSize: null,
        etaMs: null,
        etaLabel: null,
        etaNote: "Approved for funding.",
      };
    }

    const sameGroup = projects
      .filter((p) => p.status === match.status)
      .sort((a, b) => new Date(a.lastActivityAt) - new Date(b.lastActivityAt));
    const positionAhead = sameGroup.findIndex((p) => p.id === match.id);
    const etaMs = estimateWaitMs(positionAhead, throughputPerHour);

    return {
      ...match,
      positionAhead,
      groupSize: sameGroup.length,
      etaMs,
      etaLabel: etaMs != null ? formatDuration(etaMs) : null,
      etaNote: etaMs != null ? null : "Not enough recent review activity yet to estimate a wait time.",
    };
  });
}

web.get("/api/queue", (req, res) => {
  const { raw, projects } = buildEnrichedProjects();
  const allEvents = getAllEventsChronological();
  const throughputPerHour = computeRecentThroughputPerHour(allEvents);
  const projectsWithEta = attachEtaFields(projects, throughputPerHour);
  const avgResponseTimeMs = computeAvgResponseTimeMs(raw);
  res.json({
    projects: projectsWithEta,
    avgResponseTimeMs,
    avgResponseTimeLabel: formatDuration(avgResponseTimeMs),
    throughputPerHour,
  });
});

web.get("/api/log", (req, res) => {
  res.json({ events: getAllEventsChronological() });
});

// Search by project name or author. Reuses the same ETA fields already
// computed for the queue, so search results and the queue view always
// agree with each other.
web.get("/api/search", (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  if (!q) return res.json({ results: [] });

  const { projects } = buildEnrichedProjects();
  const allEvents = getAllEventsChronological();
  const throughputPerHour = computeRecentThroughputPerHour(allEvents);
  const projectsWithEta = attachEtaFields(projects, throughputPerHour);

  const results = projectsWithEta.filter(
    (p) => p.name.toLowerCase().includes(q) || p.author.toLowerCase().includes(q)
  );

  res.json({ query: q, throughputPerHour, results });
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

  try {
    await slackApp.start();
    console.log("⚡️ Stardance review bot is listening on Slack (Socket Mode)");
  } catch (err) {
    if (err.data?.error === "account_inactive" || err.data?.error === "invalid_auth") {
      console.error(
        "\nSlack rejected the bot token (" + err.data.error + "). This means the token itself is dead — " +
        "usually because it was revoked (e.g. Slack auto-revoking a token leaked in a public repo) or the " +
        "app was reinstalled. Fix: regenerate SLACK_BOT_TOKEN and SLACK_APP_TOKEN in your Slack app settings " +
        "(api.slack.com/apps > OAuth & Permissions > Revoke tokens > Reinstall to Workspace), update your .env, " +
        "and restart. Exiting instead of crash-looping.\n"
      );
      process.exit(1);
    }
    throw err; // unknown error — surface it normally
  }
})();