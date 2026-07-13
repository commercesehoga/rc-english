-- WonderMayank RC / Grammar / Vocabulary — D1 schema
-- Apply with: npx wrangler d1 execute wondermayank-rc-db --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS daily_content (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  date           TEXT NOT NULL,              -- YYYY-MM-DD, IST calendar date
  category       TEXT NOT NULL,              -- 'grammar' | 'vocabulary' | 'rc'
  passage        TEXT,                       -- only set when category = 'rc'
  question       TEXT NOT NULL,
  option_a       TEXT NOT NULL,
  option_b       TEXT NOT NULL,
  option_c       TEXT NOT NULL,
  option_d       TEXT NOT NULL,
  correct_option TEXT NOT NULL,               -- 'a' | 'b' | 'c' | 'd'
  explanation    TEXT,
  topic_tag      TEXT,                        -- e.g. 'Tenses', 'Synonyms', 'Inference'
  difficulty     TEXT,                        -- 'easy' | 'medium' | 'hard'
  created_at     TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_daily_content_date     ON daily_content(date);
CREATE INDEX IF NOT EXISTS idx_daily_content_date_cat  ON daily_content(date, category);

CREATE TABLE IF NOT EXISTS weekly_tests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start    TEXT NOT NULL UNIQUE,   -- Monday, YYYY-MM-DD (IST week)
  week_end      TEXT NOT NULL,          -- Sunday, YYYY-MM-DD
  question_ids  TEXT NOT NULL,          -- JSON array of daily_content.id, pre-shuffled
  generated_at  TEXT DEFAULT (datetime('now'))
);

-- Telegram "Sign in with Telegram" users — created/updated by /api/auth/telegram
-- after verifying the widget's signed payload against TELEGRAM_BOT_TOKEN.
CREATE TABLE IF NOT EXISTS users (
  telegram_id  INTEGER PRIMARY KEY,     -- Telegram numeric user id
  username     TEXT,
  first_name   TEXT,
  photo_url    TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT DEFAULT (datetime('now'))
);
