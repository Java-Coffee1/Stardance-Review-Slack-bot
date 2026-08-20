/**
 * Parses the three message shapes the Stardance review bot posts. All three
 * share a common structure: a bolded label, then a bolded project link in
 * mrkdwn (`*<url|name>*`), then `by <@authorId>`, then — for reviews only —
 * `*feedback from <@reviewerId>:*` followed by the feedback text.
 *
 *   NEW SUBMISSION:
 *     "*new design submission!* *<url|Name>* by <@author> :yay:
 *      *github repo:* <githubUrl|githubUrl>"
 *
 *   REVIEW RETURNED (needs changes):
 *     ":yay: brand new design review!! :stardance_star:
 *      *returned:* *<url|Name>* by <@author>
 *      *feedback from <@reviewer>:* feedback text"
 *
 *   APPROVED (for funding):
 *     ":yay: brand new design review!! :stardance_star:
 *      *approved:* *<url|Name>* by <@author>
 *      *feedback from <@reviewer>:* feedback text"
 *
 * The project URL (stardance.hackclub.com/projects/N) is extracted from
 * every message type and used as the durable identity for a project —
 * project names can be edited later, but this URL doesn't change.
 *
 * All three regexes and mrkdwnToPlain() have been verified against real
 * captured Slack payloads (see project history) — not guessed formats.
 */

function mrkdwnToPlain(text) {
  // <url|label> -> label ; <url> -> url ; strip bold asterisks
  return text
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/\*/g, "")
    .trim();
}

const PROJECT_LINK = `\\*<(https?:\\/\\/[^|>]+)\\|([^>]+)>\\*`;

const NEW_SUBMISSION_RE = new RegExp(
  `\\*new design submission!\\*\\s*${PROJECT_LINK}\\s*by\\s*(<@[\\w]+>)\\s*:\\w+:[\\s\\S]*?\\*github repo:\\*\\s*<([^|>]+)(?:\\|[^>]*)?>`,
  "i"
);

// Matches both "*returned:*" (needs changes) and "*approved:*" (approved
// for funding) — same shape, different label.
const REVIEW_RE = new RegExp(
  `\\*(returned|approved):\\*\\s*${PROJECT_LINK}\\s*by\\s*(<@[\\w]+>)\\s*\\*feedback from\\s*(<@[\\w]+>):\\*\\s*([\\s\\S]+)`,
  "i"
);

function parseNewSubmission(text) {
  const m = text.match(NEW_SUBMISSION_RE);
  if (!m) return null;
  return {
    type: "new_submission",
    projectUrl: m[1].trim(),
    name: mrkdwnToPlain(m[2]),
    authorRaw: m[3].trim(),
    githubUrl: m[4].trim(),
  };
}

function parseReview(text) {
  const m = text.match(REVIEW_RE);
  if (!m) return null;
  const label = m[1].toLowerCase();
  return {
    type: label === "approved" ? "approved" : "review_returned",
    projectUrl: m[2].trim(),
    name: mrkdwnToPlain(m[3]),
    authorRaw: m[4].trim(),
    reviewerRaw: m[5].trim(),
    feedback: mrkdwnToPlain(m[6]),
  };
}

function parseMessage(text) {
  return parseNewSubmission(text) || parseReview(text);
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

module.exports = { parseNewSubmission, parseReview, parseMessage, resolveMention };
