-- Additive migration: creates new tables only; does not drop or alter old tables.
CREATE TABLE IF NOT EXISTS download_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT,
  source_host TEXT,
  media_type TEXT,
  status TEXT NOT NULL DEFAULT 'success',
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_download_events_created_at ON download_events(created_at);
CREATE INDEX IF NOT EXISTS idx_download_events_user_id ON download_events(telegram_user_id);
CREATE TABLE IF NOT EXISTS bot_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
