// Shared "what state is this project in" logic — look at the most recent
// event only.
function computeStatus(events) {
  if (!events.length) return "unknown";
  const last = events[events.length - 1];
  if (last.type === "approved") return "approved";
  if (last.type === "new_submission") {
    return events.length > 1 ? "resub" : "awaiting";
  }
  return "needs"; // most recent event was a review that requested changes
}

const STATUS_LABEL = {
  awaiting: "Awaiting First Review",
  needs: "Needs Changes",
  resub: "Resubmitted — Awaiting Re-Review",
  approved: "Approved for Funding",
  unknown: "Unknown",
};

module.exports = { computeStatus, STATUS_LABEL };
