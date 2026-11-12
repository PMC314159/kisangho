CREATE TABLE IF NOT EXISTS conversation (
  id TEXT PRIMARY KEY CHECK (id = 'yeji-sangho'),
  memory TEXT NOT NULL DEFAULT '',
  memory_through INTEGER NOT NULL DEFAULT 0,
  lock_owner TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO conversation (id) VALUES ('yeji-sangho');

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('chat', 'scene')),
  created_at INTEGER NOT NULL,
  UNIQUE (request_id, role)
);

-- Keep every memory revision and the original messages. No TTL or deletion job.
CREATE TABLE IF NOT EXISTS memory_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  through_message INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_days (
  day TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0
);
