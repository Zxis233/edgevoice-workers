CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_archive_key TEXT,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS room_participants (
  room_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  left_at TEXT,
  last_state TEXT,
  PRIMARY KEY (room_id, peer_id),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_room_participants_room_left_at
ON room_participants (room_id, left_at);
