// Shared "what state is this project in" logic — same rule used for the
// original manual dashboard: look at the most recent event only.
function computeStatus(events) {
  if (!events.length) return "unknown";
  const last = events[events.length - 1];
  if (last.type === "new_submission") {
    return events.length > 1 ? "resub" : "awaiting";
  }
  return "needs";
}

const STATUS_LABEL = {
  awaiting: "Awaiting First Review",
  needs: "Needs Changes",
  resub: "Resubmitted — Awaiting Re-Review",
  unknown: "Unknown",
};

module.exports = { computeStatus, STATUS_LABEL };
