-- WonderMayank RC — schema v2 migration (run AFTER schema.sql, once)
-- Apply with: npx wrangler d1 execute wondermayank-rc-db --remote --file=./schema_v2.sql

-- Extra columns on users: streak/mistake summary (for bot /streak /mistakes + inactivity nudges),
-- opt-in flags, and push/nudge bookkeeping so cron never double-sends in one run.
ALTER TABLE users ADD COLUMN current_streak    INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN best_streak       INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN mistakes_open     INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN last_active_date  TEXT;              -- YYYY-MM-DD, IST, last day user completed any category
ALTER TABLE users ADD COLUMN last_push_date    TEXT;               -- last date the "today's set" push was sent
ALTER TABLE users ADD COLUMN last_nudge_date   TEXT;                -- last date an inactivity nudge was sent
ALTER TABLE users ADD COLUMN opt_out_push      INTEGER DEFAULT 0;    -- 1 = user sent /stop
ALTER TABLE users ADD COLUMN leaderboard_optin INTEGER DEFAULT 1;    -- shown on Sunday leaderboard unless opted out

-- Cross-device progress sync, one row per signed-in Telegram user. `blob` is the same JSON shape
-- progress.js keeps in localStorage (completed / mistakes / customPractice / weeklyTests),
-- so sync is a straight merge, no reshaping needed.
CREATE TABLE IF NOT EXISTS user_progress (
  telegram_id  INTEGER PRIMARY KEY,
  blob         TEXT NOT NULL,
  updated_at   TEXT DEFAULT (datetime('now'))
);

-- One-time login codes for the "log in from inside Telegram" flow (bot /login and the site's
-- "Get a login link" option). A code is created by the site (or by /login), the person approves
-- in Telegram, the webhook marks it claimed with their telegram_id, and the site polls it.
CREATE TABLE IF NOT EXISTS login_requests (
  code         TEXT PRIMARY KEY,
  telegram_id  INTEGER,
  claimed_user TEXT,                     -- JSON snapshot of {id, username, first_name, photo_url}
  created_at   TEXT DEFAULT (datetime('now')),
  claimed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_requests_created ON login_requests(created_at);

-- Weekly leaderboard is stored in a Google Sheet (see README §Leaderboard setup), not D1 — this
-- table only remembers which telegram_id already submitted a score for a given week, so a person
-- re-opening their result screen doesn't post a duplicate row to the sheet.
CREATE TABLE IF NOT EXISTS leaderboard_submissions (
  telegram_id  INTEGER NOT NULL,
  week_start   TEXT NOT NULL,
  pct          INTEGER NOT NULL,
  submitted_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (telegram_id, week_start)
);
