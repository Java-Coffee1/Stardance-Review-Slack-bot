// Average time between a project getting activity (a submission or a
// resubmission) and receiving its next review. Looks at every project's
// event list and, for each review_returned event, measures the gap since
// the event right before it — whatever that was.
function computeAvgResponseTimeMs(projects) {
  const gaps = [];

  for (const p of projects) {
    const events = p.events;
    for (let i = 1; i < events.length; i++) {
      if (events[i].type !== "review_returned") continue;
      const prev = new Date(events[i - 1].occurred_at).getTime();
      const curr = new Date(events[i].occurred_at).getTime();
      const gapMs = curr - prev;
      if (gapMs > 0) gaps.push(gapMs);
    }
  }

  if (!gaps.length) return null;
  const totalMs = gaps.reduce((sum, g) => sum + g, 0);
  return Math.round(totalMs / gaps.length);
}

// "5h 12m", "2d 3h", "38m" — whichever two units matter most.
function formatDuration(ms) {
  if (ms == null) return "—";
  const minutes = Math.round(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

module.exports = { computeAvgResponseTimeMs, formatDuration };
