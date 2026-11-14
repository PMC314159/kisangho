ALTER TABLE conversation ADD COLUMN memory_lock_owner TEXT;
ALTER TABLE conversation ADD COLUMN memory_lock_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation ADD COLUMN memory_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation ADD COLUMN memory_next_attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation ADD COLUMN memory_last_error TEXT NOT NULL DEFAULT '';
ALTER TABLE conversation ADD COLUMN memory_last_success INTEGER NOT NULL DEFAULT 0;
