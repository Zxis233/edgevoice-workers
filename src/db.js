import { DEFAULT_APP_CONFIG, normalizeAppConfig } from "./room-utils.js";

const APP_CONFIG_ROW_ID = "global";

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    capacity INTEGER NOT NULL DEFAULT 5,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_archive_key TEXT,
    archived_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS room_participants (
    room_id TEXT NOT NULL,
    peer_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    left_at TEXT,
    last_state TEXT,
    PRIMARY KEY (room_id, peer_id),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS app_config (
    id TEXT PRIMARY KEY,
    allow_room_creation INTEGER NOT NULL DEFAULT 1,
    room_name_pattern TEXT NOT NULL DEFAULT 'room-{random}',
    room_random_length INTEGER NOT NULL DEFAULT 10,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_room_participants_room_left_at
   ON room_participants (room_id, left_at)`
];

function parseParticipantState(raw) {
  if (!raw) {
    return { muted: false, speaking: false };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      muted: Boolean(parsed.muted),
      speaking: Boolean(parsed.speaking)
    };
  } catch {
    return { muted: false, speaking: false };
  }
}

function mapRoomRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    title: row.title,
    capacity: Number(row.capacity),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activeCount: Number(row.active_count ?? 0),
    lastArchiveKey: row.last_archive_key ?? null,
    archivedAt: row.archived_at ?? null
  };
}

function mapParticipantRow(row) {
  const state = parseParticipantState(row.last_state);

  return {
    peerId: row.peer_id,
    displayName: row.display_name,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    muted: state.muted,
    speaking: state.speaking
  };
}

function mapAppConfigRow(row) {
  if (!row) {
    return {
      ...DEFAULT_APP_CONFIG,
      updatedAt: null
    };
  }

  return {
    ...normalizeAppConfig({
      allowRoomCreation: Boolean(row.allow_room_creation),
      roomNamePattern: row.room_name_pattern,
      roomRandomLength: Number(row.room_random_length)
    }),
    updatedAt: row.updated_at
  };
}

function countChanges(result) {
  return Number(result.meta?.changes ?? result.meta?.rows_written ?? 0);
}

async function ensureAppConfigRow(db) {
  await db
    .prepare(
      `INSERT INTO app_config (
         id,
         allow_room_creation,
         room_name_pattern,
         room_random_length,
         updated_at
       )
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(id) DO NOTHING`
    )
    .bind(
      APP_CONFIG_ROW_ID,
      1,
      DEFAULT_APP_CONFIG.roomNamePattern,
      DEFAULT_APP_CONFIG.roomRandomLength,
      new Date().toISOString()
    )
    .run();
}

export async function bootstrapDatabase(db) {
  await db.batch(SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)));
}

export async function getAppConfig(db) {
  await bootstrapDatabase(db);
  await ensureAppConfigRow(db);

  const row = await db
    .prepare(
      `SELECT
         id,
         allow_room_creation,
         room_name_pattern,
         room_random_length,
         updated_at
       FROM app_config
       WHERE id = ?1`
    )
    .bind(APP_CONFIG_ROW_ID)
    .first();

  return mapAppConfigRow(row);
}

export async function updateAppConfig(db, appConfig) {
  await bootstrapDatabase(db);
  await ensureAppConfigRow(db);

  const current = await getAppConfig(db);
  const nextConfig = normalizeAppConfig({
    ...current,
    ...appConfig
  });
  const updatedAt = new Date().toISOString();

  await db
    .prepare(
      `UPDATE app_config
       SET allow_room_creation = ?2,
           room_name_pattern = ?3,
           room_random_length = ?4,
           updated_at = ?5
       WHERE id = ?1`
    )
    .bind(
      APP_CONFIG_ROW_ID,
      nextConfig.allowRoomCreation ? 1 : 0,
      nextConfig.roomNamePattern,
      nextConfig.roomRandomLength,
      updatedAt
    )
    .run();

  return {
    ...nextConfig,
    updatedAt
  };
}

export async function createRoom(db, room) {
  await bootstrapDatabase(db);

  const result = await db
    .prepare(
      `INSERT INTO rooms (id, title, capacity, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'active', ?4, ?4)
       ON CONFLICT(id) DO NOTHING`
    )
    .bind(room.id, room.title, room.capacity, room.createdAt)
    .run();

  const changes = countChanges(result);
  return changes > 0 ? room : null;
}

export async function listActiveParticipants(db, roomId) {
  await bootstrapDatabase(db);

  const { results } = await db
    .prepare(
      `SELECT peer_id, display_name, joined_at, left_at, last_state
       FROM room_participants
       WHERE room_id = ?1 AND left_at IS NULL
       ORDER BY joined_at ASC`
    )
    .bind(roomId)
    .all();

  return results.map(mapParticipantRow);
}

export async function getRoom(db, roomId) {
  await bootstrapDatabase(db);

  const roomRow = await db
    .prepare(
      `SELECT
         r.*,
         COALESCE(active.active_count, 0) AS active_count
       FROM rooms AS r
       LEFT JOIN (
         SELECT room_id, COUNT(*) AS active_count
         FROM room_participants
         WHERE left_at IS NULL
         GROUP BY room_id
       ) AS active
         ON active.room_id = r.id
       WHERE r.id = ?1`
    )
    .bind(roomId)
    .first();

  if (!roomRow) {
    return null;
  }

  const participants = await listActiveParticipants(db, roomId);

  return {
    ...mapRoomRow(roomRow),
    participants
  };
}

export async function upsertParticipant(db, participant) {
  await bootstrapDatabase(db);

  const state = JSON.stringify({
    muted: Boolean(participant.muted),
    speaking: Boolean(participant.speaking)
  });

  await db.batch([
    db
      .prepare(
        `INSERT INTO room_participants (
           room_id,
           peer_id,
           display_name,
           joined_at,
           left_at,
           last_state
         )
         VALUES (?1, ?2, ?3, ?4, NULL, ?5)
         ON CONFLICT(room_id, peer_id) DO UPDATE SET
           display_name = excluded.display_name,
           joined_at = excluded.joined_at,
           left_at = NULL,
           last_state = excluded.last_state`
      )
      .bind(
        participant.roomId,
        participant.peerId,
        participant.displayName,
        participant.joinedAt,
        state
      ),
    db
      .prepare(
        `UPDATE rooms
         SET status = 'active',
             updated_at = ?2
         WHERE id = ?1`
      )
      .bind(participant.roomId, participant.joinedAt)
  ]);
}

export async function updateParticipantState(db, participant) {
  await bootstrapDatabase(db);

  const state = JSON.stringify({
    muted: Boolean(participant.muted),
    speaking: Boolean(participant.speaking)
  });

  await db
    .prepare(
      `UPDATE room_participants
       SET last_state = ?3
       WHERE room_id = ?1 AND peer_id = ?2`
    )
    .bind(participant.roomId, participant.peerId, state)
    .run();
}

export async function markParticipantLeft(db, roomId, peerId, leftAt) {
  await bootstrapDatabase(db);

  await db.batch([
    db
      .prepare(
        `UPDATE room_participants
         SET left_at = ?3
         WHERE room_id = ?1 AND peer_id = ?2 AND left_at IS NULL`
      )
      .bind(roomId, peerId, leftAt),
    db
      .prepare(
        `UPDATE rooms
         SET updated_at = ?2
         WHERE id = ?1`
      )
      .bind(roomId, leftAt)
  ]);
}

export async function deleteEmptyRooms(db) {
  await bootstrapDatabase(db);

  await db
    .prepare(
      `DELETE FROM room_participants
       WHERE room_id IN (
         SELECT id
         FROM rooms
         WHERE NOT EXISTS (
           SELECT 1
           FROM room_participants AS active
           WHERE active.room_id = rooms.id
             AND active.left_at IS NULL
         )
       )`
    )
    .run();

  const result = await db
    .prepare(
      `DELETE FROM rooms
       WHERE NOT EXISTS (
         SELECT 1
         FROM room_participants AS active
         WHERE active.room_id = rooms.id
           AND active.left_at IS NULL
       )`
    )
    .run();

  return countChanges(result);
}

export async function archiveRoom(env, roomId, archivedAt) {
  await bootstrapDatabase(env.DB);

  const room = await getRoom(env.DB, roomId);
  if (!room || env.ROOM_ARCHIVE === undefined) {
    return null;
  }

  const { results } = await env.DB
    .prepare(
      `SELECT peer_id, display_name, joined_at, left_at, last_state
       FROM room_participants
       WHERE room_id = ?1
       ORDER BY joined_at ASC`
    )
    .bind(roomId)
    .all();

  const payload = {
    room: {
      id: room.id,
      title: room.title,
      capacity: room.capacity,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt
    },
    archivedAt,
    participants: results.map(mapParticipantRow)
  };

  const key = `rooms/${roomId}/${archivedAt.replace(/[:.]/g, "-")}.json`;

  await env.ROOM_ARCHIVE.put(key, JSON.stringify(payload, null, 2), {
    httpMetadata: {
      contentType: "application/json"
    }
  });

  await env.DB
    .prepare(
      `UPDATE rooms
       SET status = 'archived',
           updated_at = ?2,
           archived_at = ?2,
           last_archive_key = ?3
       WHERE id = ?1`
    )
    .bind(roomId, archivedAt, key)
    .run();

  return { key, payload };
}
