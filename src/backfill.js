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
 * exactly the Retry-After duration it specifies.
 *
 * Resilience: each message is processed in its own try/catch. One bad or
 * unexpectedly-shaped message logs a warning (with the raw text, so it can
 * be diagnosed) and gets skipped, rather than aborting the whole batch and
 * losing everything already imported on that run.
 */
require("dotenv").config();
const { WebClient } = require("@slack/web-api");
const { findOrCreateProject, insertEvent } = require("./db");
const { parseMessage, resolveMention } = require("./parser");
const { isFromReviewBot } = require("./trust");

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
        throw err;
      }
    }
  }

  let cursor;
  let imported = 0;
  let skipped = 0;
  let untrusted = 0;
  let errored = 0;
  let pagesFetched = 0;

  do {
    const res = await fetchHistoryPage(cursor);
    pagesFetched++;

    // Slack returns newest-first; process oldest-first so events insert in order.
    const messages = [...res.messages].reverse();
    console.log(`[backfill] Page ${pagesFetched}: fetched ${messages.length} messages (${imported} imported so far)`);

    for (const msg of messages) {
      if (!msg.text) continue;
      if (!isFromReviewBot(msg)) {
        untrusted++;
        continue;
      }

      try {
        const parsed = parseMessage(msg.text);
        if (!parsed) {
          skipped++;
          continue;
        }

        if (!parsed.projectUrl) {
          // Shouldn't happen given how the parser is built, but guard
          // against the exact NOT NULL crash we hit, and log enough to
          // diagnose it instead of losing the whole batch.
          console.warn(`[backfill] Parsed message but got no projectUrl — skipping. ts=${msg.ts}\n  text: ${msg.text}`);
          skipped++;
          continue;
        }

        const occurredAt = new Date(Number(msg.ts) * 1000).toISOString();
        const author = await resolveCached(parsed.authorRaw);

        const projectId = findOrCreateProject({
          projectUrl: parsed.projectUrl,
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
            type: parsed.type,
            reviewer,
            feedback: parsed.feedback,
            slackTs: msg.ts,
            occurredAt,
            rawText: msg.text,
          });
        }
        imported++;
      } catch (err) {
        // Don't let one bad message abort everything already imported this run.
        errored++;
        console.warn(`[backfill] Failed to process message (ts=${msg.ts}), skipping it: ${err.message}\n  text: ${msg.text}`);
      }
    }

    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  console.log(`[backfill] Done. Fetched ${pagesFetched} pages, imported ${imported} events, skipped ${skipped} unmatched, ${untrusted} untrusted, ${errored} errored.`);
  return { pagesFetched, imported, skipped, untrusted, errored };
}

module.exports = { runBackfill };

if (require.main === module) {
  runBackfill().catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
}