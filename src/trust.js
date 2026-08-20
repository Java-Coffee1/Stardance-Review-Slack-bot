// Verifies a Slack message actually came from the review bot, not just that
// its *text* happens to match the expected shape. Without this, any channel
// member could type a message shaped like:
//   "*approved:* *<url|Name>* by <@x> *feedback from <@y>:* ..."
// and have it accepted as a real event — including flipping a project to
// "Approved for Funding."
//
// REVIEW_BOT_ID is the review bot's Slack bot_id (not its user id, and not
// the app's client_id). Easiest way to find it: run `node src/inspect.js`
// — it prints the raw JSON of a real review-bot message; look for the
// "bot_id" field on it.

const REVIEW_BOT_ID = process.env.REVIEW_BOT_ID || null;

if (!REVIEW_BOT_ID) {
  console.warn(
    "[trust] REVIEW_BOT_ID is not set — accepting submission/review messages from ANY " +
    "channel member, not just the real review bot. Set REVIEW_BOT_ID in .env to lock this " +
    "down (run `node src/inspect.js` to find it, see README)."
  );
}

// Works against both a live Socket Mode `event` and a `conversations.history`
// message object — both carry `bot_id` the same way when a bot posted them.
function isFromReviewBot(event) {
  if (!REVIEW_BOT_ID) return true; // verification disabled — matches prior behavior
  return event.bot_id === REVIEW_BOT_ID;
}

module.exports = { isFromReviewBot };