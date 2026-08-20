/**
 * Run once after setup to import everything the bot missed (messages posted
 * before it was invited to the channel):
 *
 *   node src/backfill.js
 *
 * Requires the bot token to have the `channels:history` (or `groups:history`
 * for private channels) scope, and the bot to already be a member of the
 * channel (invite it with /invite @YourBotName first).
 */
require("dotenv").config();
const { WebClient } = require("@slack/web-api");
const { findOrCreateProject, insertEvent } = require("./db");
const { parseMessage, resolveMention } = require("./parser");

const client = new WebClient(process.env.SLACK_BOT_TOKEN);
const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

async function run() {
  if (!CHANNEL_ID) {
    console.error("Set SLACK_CHANNEL_ID in .env first.");
    process.exit(1);
  }

  let cursor;
  let imported = 0;
  let skipped = 0;

  do {
    const res = await client.conversations.history({
      channel: CHANNEL_ID,
      cursor,
      limit: 200,
    });

    // Slack returns newest-first; process oldest-first so events insert in order.
    const messages = [...res.messages].reverse();

    for (const msg of messages) {
      if (!msg.text) continue;
      const parsed = parseMessage(msg.text);
      if (!parsed) {
        skipped++;
        continue;
      }

      const occurredAt = new Date(Number(msg.ts) * 1000).toISOString();
      const author = await resolveMention(parsed.authorRaw, client);

      const projectId = findOrCreateProject({
        name: parsed.name,
        author,
        githubUrl: parsed.type === "new_submission" ? parsed.githubUrl : null,
        occurredAt,
      });

      if (parsed.type === "new_submission") {
        insertEvent({ projectId, type: "new_submission", slackTs: msg.ts, occurredAt, rawText: msg.text });
      } else {
        const reviewer = await resolveMention(parsed.reviewerRaw, client);
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
  } while (cursor);

  console.log(`Backfill done. Imported ${imported} events, skipped ${skipped} unmatched messages.`);
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
