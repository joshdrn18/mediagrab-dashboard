-- Run ONCE in the same D1 database used by mediagrab-bot and mediagrab-admin-api.
-- This is additive: existing download_events rows are preserved.
ALTER TABLE download_events ADD COLUMN telegram_username TEXT;
ALTER TABLE download_events ADD COLUMN source_url TEXT;
ALTER TABLE download_events ADD COLUMN filename TEXT;
ALTER TABLE download_events ADD COLUMN size_bytes INTEGER;
CREATE INDEX IF NOT EXISTS idx_download_events_user ON download_events(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_download_events_source_host ON download_events(source_host);
