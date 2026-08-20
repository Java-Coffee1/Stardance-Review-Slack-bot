const REVIEW_EVENT_TYPES = new Set(["review_returned", "approved"]);
function isReviewEvent(type) {
  return REVIEW_EVENT_TYPES.has(type);
}

// Average time between a project getting activity (a submission or a
// resubmission) and receiving its next review (whether it came back
// "needs changes" or "approved" — both are a reviewer completing a pass).
function computeAvgResponseTimeMs(projects) {
  const gaps = [];

  for (const p of projects) {
    const events = p.events;
    for (let i = 1; i < events.length; i++) {
      if (!isReviewEvent(events[i].type)) continue;
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

// How many reviews-per-hour reviewers have actually been getting through
// recently (counting both rejections and approvals as completed reviews).
// This is a throughput rate (reviewers work in parallel), not "how long
// does one review take" — that's what makes it usable for estimating
// queue wait time rather than per-project turnaround.
//
// Window-based, not just "last N reviews": if reviewing slowed way down
// months ago, that shouldn't drag down today's estimate just because it's
// still within the last 20 events. We look at reviews from the last
// `windowDays` (relative to the most recent review, not wall-clock time,
// so this still works sensibly against historical/backfilled data). If
// there isn't enough recent activity to get a reliable rate from, we fall
// back to a count-based sample so there's still *some* estimate.
function computeRecentThroughputPerHour(allEventsChronological, { windowDays = 14, fallbackSampleSize = 20 } = {}) {
  const reviews = allEventsChronological
    .filter((e) => isReviewEvent(e.type))
    .map((e) => ({ ...e, t: new Date(e.occurred_at).getTime() }))
    .sort((a, b) => a.t - b.t);

  if (reviews.length < 2) return null;

  const latestT = reviews[reviews.length - 1].t;
  const windowStart = latestT - windowDays * 24 * 3_600_000;
  const windowed = reviews.filter((r) => r.t >= windowStart);

  // Prefer the recent window; only fall back to a plain count-based sample
  // if the window doesn't have enough data points to be meaningful.
  const sample = windowed.length >= 2 ? windowed : reviews.slice(-fallbackSampleSize);

  const first = sample[0].t;
  const last = sample[sample.length - 1].t;
  const hours = (last - first) / 3_600_000;
  if (hours <= 0) return null;

  return (sample.length - 1) / hours; // reviews per hour
}

// Given how many projects are ahead of this one in its queue group, and the
// current review throughput, estimate how long until this one gets looked
// at. Returns null if there's not enough data to estimate from.
function estimateWaitMs(positionAhead, throughputPerHour) {
  if (!throughputPerHour || throughputPerHour <= 0) return null;
  const hours = positionAhead / throughputPerHour;
  return Math.round(hours * 3_600_000);
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

module.exports = {
  computeAvgResponseTimeMs,
  computeRecentThroughputPerHour,
  estimateWaitMs,
  formatDuration,
  isReviewEvent,
};
