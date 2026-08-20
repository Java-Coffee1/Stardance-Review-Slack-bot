// src/inspect.js — dumps raw Slack message JSON for the channel. Originally a
// throwaway debug script; now also the easiest way to find REVIEW_BOT_ID (see
// README) — run this, grab the "bot_id" field off a real review-bot message.
require("dotenv").config();
const { WebClient } = require("@slack/web-api");
const client = new WebClient(process.env.SLACK_BOT_TOKEN);

(async () => {
  const res = await client.conversations.history({
    channel: process.env.SLACK_CHANNEL_ID,
    limit: 200,
  });

  const approved = res.messages.find(m => /approv|fund/i.test(m.text || ""));
  const reviewed = res.messages.find(m => /returned:/i.test(m.text || ""));

  console.log("=== POSSIBLE APPROVAL MESSAGE ===");
  console.log(approved ? JSON.stringify(approved, null, 2) : "None found in last 200 messages.");

  console.log("\n=== REVIEW-RETURNED MESSAGE (checking for project URL) ===");
  console.log(reviewed ? JSON.stringify(reviewed, null, 2) : "None found in last 200 messages.");
})();