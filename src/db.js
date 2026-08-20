const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "..", "data", "queue.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  author TEXT NOT NULL,
  github_url TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(name, author)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  type TEXT NOT NULL,             -- 'new_submission' | 'review_returned'
  reviewer TEXT,                  -- set when type = review_returned
  feedback TEXT,                  -- set when type = review_returned
  slack_ts TEXT NOT NULL,         -- Slack message timestamp (sortable, unique-ish)
  occurred_at TEXT NOT NULL,      -- ISO string derived from slack_ts
  raw_text TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(slack_ts);
`);

function findOrCreateProject({ name, author, githubUrl, occurredAt }) {
  const existing = db
    .prepare("SELECT * FROM projects WHERE name = ? AND author = ?")
    .get(name, author);
  if (existing) {
    if (githubUrl && !existing.github_url) {
      db.prepare("UPDATE projects SET github_url = ? WHERE id = ?").run(githubUrl, existing.id);
    }
    return existing.id;
  }
  const info = db
    .prepare("INSERT INTO projects (name, author, github_url, created_at) VALUES (?, ?, ?, ?)")
    .run(name, author, githubUrl || null, occurredAt);
  return info.lastInsertRowid;
}

function insertEvent({ projectId, type, reviewer, feedback, slackTs, occurredAt, rawText }) {
  // avoid duplicate inserts if the bot reprocesses the same Slack message
  const dup = db.prepare("SELECT id FROM events WHERE slack_ts = ?").get(slackTs);
  if (dup) return dup.id;
  const info = db
    .prepare(
      `INSERT INTO events (project_id, type, reviewer, feedback, slack_ts, occurred_at, raw_text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(projectId, type, reviewer || null, feedback || null, slackTs, occurredAt, rawText || null);
  return info.lastInsertRowid;
}

function getAllProjectsWithEvents() {
  const projects = db.prepare("SELECT * FROM projects").all();
  const eventStmt = db.prepare("SELECT * FROM events WHERE project_id = ? ORDER BY slack_ts ASC");
  return projects.map((p) => ({
    ...p,
    events: eventStmt.all(p.id),
  }));
}

function getAllEventsChronological() {
  return db
    .prepare(
      `SELECT events.*, projects.name AS project_name, projects.author AS project_author, projects.github_url
       FROM events JOIN projects ON events.project_id = projects.id
       ORDER BY events.slack_ts ASC`
    )
    .all();
}

module.exports = { db, findOrCreateProject, insertEvent, getAllProjectsWithEvents, getAllEventsChronological };
