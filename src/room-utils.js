const ROOM_TITLE_LIMIT = 48;
const DISPLAY_NAME_LIMIT = 32;

export function createRoomId() {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  return `room-${token}`;
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
  return trimmed.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 64);
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

export function toParticipantSnapshot(participant) {
  return {
    peerId: participant.peerId,
    displayName: participant.displayName,
    joinedAt: participant.joinedAt,
    muted: Boolean(participant.muted),
    speaking: Boolean(participant.speaking)
  };
}
