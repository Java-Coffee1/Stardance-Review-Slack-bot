/**
 * Parses the two message shapes the Stardance review bot posts:
 *
 *  NEW SUBMISSION:
 *    "new design submission! {ProjectName} by @{author} :yay:
 *     github repo: {url}"
 *
 *  REVIEW RETURNED:
 *    ":yay: brand new design review!! :stardance_star:
 *
 *      returned: {ProjectName} by @{author}
 *     feedback from @{reviewer}: {feedback text}"
 *
 * Real Slack events carry user mentions as <@U12345> — resolveMention()
 * below turns those into @handle using the Slack Web API. If a message
 * doesn't match either shape, both parse functions return null so the
 * caller can skip/log it instead of inserting garbage.
 */

const NEW_SUBMISSION_RE =
  /new design submission!\s*(.+?)\s+by\s+(<@[\w]+>|@\S[^\n:]*?)\s*:\w+:[\s\S]*?github repo:\s*(\S+)/i;

const REVIEW_RETURNED_RE =
  /returned:\s*(.+?)\s+by\s+(<@[\w]+>|@\S+)[\s\n]*feedback from\s+(<@[\w]+>|@\S+)\s*:\s*([\s\S]+)/i;

function parseNewSubmission(text) {
  const m = text.match(NEW_SUBMISSION_RE);
  if (!m) return null;
  return {
    type: "new_submission",
    name: m[1].trim(),
    authorRaw: m[2].trim(),
    githubUrl: m[3].trim(),
  };
}

function parseReviewReturned(text) {
  const m = text.match(REVIEW_RETURNED_RE);
  if (!m) return null;
  return {
    type: "review_returned",
    name: m[1].trim(),
    authorRaw: m[2].trim(),
    reviewerRaw: m[3].trim(),
    // Trim trailing unfurl/link-preview junk Slack sometimes appends after the feedback text.
    feedback: m[4].split(/\n{2,}/)[0].trim(),
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
