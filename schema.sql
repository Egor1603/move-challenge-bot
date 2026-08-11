CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER UNIQUE NOT NULL,
  username TEXT,
  full_name TEXT,
  city TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  entry_date TEXT NOT NULL, -- YYYY-MM-DD
  steps INTEGER DEFAULT 0,
  activity_minutes INTEGER DEFAULT 0,
  together INTEGER DEFAULT 0,
  community INTEGER DEFAULT 0,
  photo_file_id TEXT,
  photo_url TEXT,
  points INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending', -- pending / approved / rejected
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
  -- Раньше тут был UNIQUE(user_id, entry_date) — теперь до 2 записей
  -- в день разрешено на уровне кода бота (см. saveEntry в src/index.js)
);

CREATE TABLE IF NOT EXISTS sessions (
  tg_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT DEFAULT (datetime('now'))
);