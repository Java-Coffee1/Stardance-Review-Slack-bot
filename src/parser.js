/**
 * Parses the review bot's messages. Slack delivers these with real mrkdwn
 * syntax in event.text — bold via *text*, links via <url|label>, mentions
 * via <@USERID> — not plain stripped text. Confirmed against real payloads:
 *
 *   "*new design submission!* *<https://.../projects/48410|AeroTrack>*
 *    by <@U0B8K9XGVMM> :yay: *github repo:*
 *    <https://github.com/x/y|https://github.com/x/y>"
 *
 * The "review returned" shape hasn't been confirmed against a raw payload
 * yet, so its regex is written loosely (tolerating any amount of whitespace
 * between segments) to survive minor formatting differences. If it still
 * doesn't match after this fix, run the inspect script filtered to a
 * "review_returned"-type message and send that over.
 */

function mrkdwnToPlain(text) {
  // <url|label> -> label ; <url> -> url ; strip bold asterisks
  return text
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/\*/g, "")
    .trim();
}

const NEW_SUBMISSION_RE =
  /\*new design submission!\*\s*\*(.+?)\*\s*by\s*(<@[\w]+>)\s*:\w+:[\s\S]*?\*github repo:\*\s*<([^|>]+)(?:\|[^>]*)?>/i;

const REVIEW_RETURNED_RE =
  /returned:\s*\*(.+?)\*\s*by\s*(<@[\w]+>)[\s\S]*?feedback from\s*(<@[\w]+>)\s*:\s*([\s\S]+)/i;

function parseNewSubmission(text) {
  const m = text.match(NEW_SUBMISSION_RE);
  if (!m) return null;
  return {
    type: "new_submission",
    name: mrkdwnToPlain(m[1]),
    authorRaw: m[2].trim(),
    githubUrl: m[3].trim(),
  };
}

function parseReviewReturned(text) {
  const m = text.match(REVIEW_RETURNED_RE);
  if (!m) return null;
  return {
    type: "review_returned",
    name: mrkdwnToPlain(m[1]),
    authorRaw: m[2].trim(),
    reviewerRaw: m[3].trim(),
    feedback: mrkdwnToPlain(m[4]),
  };
}

function parseMessage(text) {
  return parseNewSubmission(text) || parseReviewReturned(text);
}

/**
 * Turns a raw mention into a display handle.
 * - "<@U12345>" -> resolved via Slack API (users.info) -> "@display_name"
 * - "@already_a_handle" -> returned as-is
 */
async function resolveMention(raw, slackClient) {
  const idMatch = raw.match(/^<@([\w]+)>$/);
  if (!idMatch) return raw.startsWith("@") ? raw : `@${raw}`;
  try {
    const res = await slackClient.users.info({ user: idMatch[1] });
    const handle =
      res.user?.profile?.display_name || res.user?.profile?.real_name || res.user?.name || idMatch[1];
    return `@${handle}`;
  } catch (err) {
    return `@${idMatch[1]}`; // fall back to raw ID if lookup fails (e.g. missing users:read scope)
  }
}

module.exports = { parseNewSubmission, parseReviewReturned, parseMessage, resolveMention };