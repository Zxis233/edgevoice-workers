const ROOM_TITLE_LIMIT = 48;
const DISPLAY_NAME_LIMIT = 32;
const ROOM_NAME_PATTERN_LIMIT = 48;

export const DEFAULT_APP_CONFIG = Object.freeze({
  allowRoomCreation: true,
  roomNamePattern: "room-{random}",
  roomRandomLength: 10
});

export const ROOM_RANDOM_LENGTH_RANGE = Object.freeze({
  min: 4,
  max: 24
});

function sanitizeRoomId(rawValue, fallbackToken) {
  const sanitized = `${rawValue ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  return sanitized || `room-${fallbackToken}`;
}

export function normalizeRoomNamePattern(value) {
  const compact = `${value ?? ""}`
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9-{}]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ROOM_NAME_PATTERN_LIMIT);

  const basePattern = compact || DEFAULT_APP_CONFIG.roomNamePattern;

  if (basePattern.includes("{random}")) {
    return basePattern;
  }

  return `${basePattern}-{random}`;
}

export function clampRoomRandomLength(value) {
  const parsed = Number.parseInt(`${value ?? ""}`, 10);

  if (Number.isNaN(parsed)) {
    return DEFAULT_APP_CONFIG.roomRandomLength;
  }

  return Math.max(
    ROOM_RANDOM_LENGTH_RANGE.min,
    Math.min(parsed, ROOM_RANDOM_LENGTH_RANGE.max)
  );
}

function buildRoomId(config, token) {
  const roomNamePattern = normalizeRoomNamePattern(config?.roomNamePattern);
  const roomRandomLength = clampRoomRandomLength(config?.roomRandomLength);
  const randomToken = `${token ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, roomRandomLength)
    .padEnd(roomRandomLength, "x");

  return sanitizeRoomId(roomNamePattern.replaceAll("{random}", randomToken), randomToken);
}

export function createRoomId(config = DEFAULT_APP_CONFIG) {
  const randomToken = crypto.randomUUID()
    .replace(/-/g, "")
    .slice(0, clampRoomRandomLength(config?.roomRandomLength));
  return buildRoomId(config, randomToken);
}

export function previewRoomId(config = DEFAULT_APP_CONFIG) {
  return buildRoomId(config, "previewtoken");
}

export function normalizeTitle(value) {
  const trimmed = `${value ?? ""}`.trim().replace(/\s+/g, " ");
  return (trimmed || "Quick Voice Room").slice(0, ROOM_TITLE_LIMIT);
}

export function normalizeDisplayName(value) {
  const trimmed = `${value ?? ""}`.trim().replace(/\s+/g, " ");
  return trimmed.slice(0, DISPLAY_NAME_LIMIT);
}

export function normalizePeerId(value) {
  const trimmed = `${value ?? ""}`.trim();
  return trimmed.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 32);
}

export function clampCapacity(value, env) {
  const parsed = Number.parseInt(`${value ?? ""}`, 10);
  const maxCapacity = Math.min(Number.parseInt(env.MAX_ROOM_CAPACITY ?? "5", 10) || 5, 5);
  const defaultCapacity = Math.min(
    Number.parseInt(env.DEFAULT_ROOM_CAPACITY ?? "5", 10) || 5,
    maxCapacity
  );

  if (Number.isNaN(parsed)) {
    return defaultCapacity;
  }

  return Math.max(2, Math.min(parsed, maxCapacity));
}

export function normalizeAppConfig(value) {
  return {
    allowRoomCreation: value?.allowRoomCreation !== false,
    roomNamePattern: normalizeRoomNamePattern(value?.roomNamePattern),
    roomRandomLength: clampRoomRandomLength(value?.roomRandomLength)
  };
}

export function toParticipantSnapshot(participant) {
  return {
    peerId: participant.peerId,
    displayName: participant.displayName,
    joinedAt: participant.joinedAt,
    muted: Boolean(participant.muted),
    speaking: Boolean(participant.speaking)
  };
}
