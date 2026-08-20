/**
 * Imports channel history into the database. Used two ways:
 *
 *   1. Manually:      node src/backfill.js
 *   2. Automatically: server.js calls runBackfill() on startup if the
 *      database is empty (see the "auto-backfill on empty DB" note there).
 *
 * Requires the bot token to have the `channels:history` (or `groups:history`
 * for private channels) scope, and the bot to already be a member of the
 * channel (invite it with /invite @YourBotName first).
 *
 * Rate limiting: requests the max page size Slack allows (999) on every
 * call and only pauses when Slack actually returns a 429, backing off for
 * exactly the Retry-After duration it specifies. That's the fastest legal
 * pace regardless of which tier your app is on — a private, single-workspace
 * bot like this one normally qualifies as an "internal customer-built app"
 * (Tier 3: 999/request, 50+ requests/min), not the stricter 15/request,
 * 1/min tier that applies to commercially-distributed non-Marketplace apps.
 */
require("dotenv").config();
const { WebClient } = require("@slack/web-api");
const { findOrCreateProject, insertEvent } = require("./db");
const { parseMessage, resolveMention } = require("./parser");

const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const PAGE_SIZE = Number(process.env.SLACK_HISTORY_PAGE_SIZE || 999); // Slack's actual max
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runBackfill() {
  if (!CHANNEL_ID) {
    throw new Error("SLACK_CHANNEL_ID is not set — cannot backfill.");
  }

  const client = new WebClient(process.env.SLACK_BOT_TOKEN, {
    rejectRateLimitedCalls: false,
  });

  // Resolving a mention hits users.info — cache handles across the whole
  // run so we don't burn extra API calls re-resolving the same person.
  const mentionCache = new Map();
  async function resolveCached(raw) {
    if (mentionCache.has(raw)) return mentionCache.get(raw);
    const resolved = await resolveMention(raw, client);
    mentionCache.set(raw, resolved);
    return resolved;
  }

  async function fetchHistoryPage(cursor) {
    while (true) {
      try {
        return await client.conversations.history({ channel: CHANNEL_ID, cursor, limit: PAGE_SIZE });
      } catch (err) {
        const isRateLimited = err.code === "slack_webapi_platform_error" && err.data?.error === "ratelimited";
        const retryAfter = Number(err.data?.retry_after || err.retryAfter || 60);
        if (isRateLimited || err.code === "slack_webapi_rate_limited_error") {
          console.log(`[backfill] Rate limited by Slack — waiting ${retryAfter}s before retrying...`);
          await sleep((retryAfter + 1) * 1000);
          continue;
        }
        throw err; // not a rate-limit error — surface it
      }
    }
  }

  let cursor;
  let imported = 0;
  let skipped = 0;
  let pagesFetched = 0;

  do {
    const res = await fetchHistoryPage(cursor);
    pagesFetched++;

    // Slack returns newest-first; process oldest-first so events insert in order.
    const messages = [...res.messages].reverse();
    console.log(`[backfill] Page ${pagesFetched}: fetched ${messages.length} messages (${imported} imported so far)`);

    for (const msg of messages) {
      if (!msg.text) continue;
      const parsed = parseMessage(msg.text);
      if (!parsed) {
        skipped++;
        continue;
      }

      const occurredAt = new Date(Number(msg.ts) * 1000).toISOString();
      const author = await resolveCached(parsed.authorRaw);

      const projectId = findOrCreateProject({
        name: parsed.name,
        author,
        githubUrl: parsed.type === "new_submission" ? parsed.githubUrl : null,
        occurredAt,
      });

      if (parsed.type === "new_submission") {
        insertEvent({ projectId, type: "new_submission", slackTs: msg.ts, occurredAt, rawText: msg.text });
      } else {
        const reviewer = await resolveCached(parsed.reviewerRaw);
        insertEvent({
          projectId,
          type: "review_returned",
          reviewer,
          feedback: parsed.feedback,
          slackTs: msg.ts,
          occurredAt,
          rawText: msg.text,
        });
      }
      imported++;
    }

    cursor = res.response_metadata?.next_cursor || undefined;
    // No fixed sleep here — only pause inside fetchHistoryPage, and only if
    // Slack actually rate-limits us.
  } while (cursor);

  console.log(`[backfill] Done. Fetched ${pagesFetched} pages, imported ${imported} events, skipped ${skipped} unmatched messages.`);
  return { pagesFetched, imported, skipped };
}

module.exports = { runBackfill };

// Only auto-run when invoked directly (`npm run backfill` / `node src/backfill.js`)
// — not when imported by server.js for the empty-database auto-backfill.
if (require.main === module) {
  runBackfill().catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
}