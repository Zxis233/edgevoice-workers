import { bootstrapDatabase, createRoom, getRoom } from "./db.js";
import { errorResponse, json, readJson } from "./http.js";
import { resolveIceServers } from "./ice.js";
import { VoiceRoom } from "./room-do.js";
import {
  clampCapacity,
  createRoomId,
  normalizeDisplayName,
  normalizePeerId,
  normalizeTitle
} from "./room-utils.js";

function buildJoinUrl(requestUrl, roomId) {
  const joinUrl = new URL(requestUrl.origin);
  joinUrl.searchParams.set("room", roomId);
  return joinUrl.toString();
}

async function handleCreateRoom(request, env) {
  const payload = await readJson(request);
  const title = normalizeTitle(payload.title);
  const capacity = clampCapacity(payload.capacity, env);
  const createdAt = new Date().toISOString();
  const room = await createRoom(env.DB, {
    id: createRoomId(),
    title,
    capacity,
    createdAt
  });

  return json(
    {
      room: {
        ...room,
        activeCount: 0
      },
      joinUrl: buildJoinUrl(new URL(request.url), room.id)
    },
    { status: 201 }
  );
}

async function handleGetRoom(request, env, roomId) {
  const room = await getRoom(env.DB, roomId);
  if (!room) {
    return errorResponse(404, "Room not found.");
  }

  return json({
    room,
    joinUrl: buildJoinUrl(new URL(request.url), roomId)
  });
}

async function handleIceServers(env) {
  const iceServers = await resolveIceServers(env);
  return json({ iceServers });
}

async function handleRoomSocket(request, env, roomId) {
  const upgrade = request.headers.get("Upgrade");
  if (upgrade?.toLowerCase() !== "websocket") {
    return errorResponse(426, "Expected Upgrade: websocket.");
  }

  const room = await getRoom(env.DB, roomId);
  if (!room) {
    return errorResponse(404, "Room not found.");
  }

  if (room.activeCount >= room.capacity) {
    return errorResponse(409, "Room is full.");
  }

  const url = new URL(request.url);
  const peerId = normalizePeerId(url.searchParams.get("peerId"));
  const displayName = normalizeDisplayName(url.searchParams.get("name"));

  if (!peerId || !displayName) {
    return errorResponse(400, "Missing peerId or displayName.");
  }

  const headers = new Headers(request.headers);
  headers.set("x-room-capacity", String(room.capacity));

  const roomIdFromName = env.VOICE_ROOMS.idFromName(roomId);
  const stub = env.VOICE_ROOMS.get(roomIdFromName);
  return stub.fetch(new Request(request, { headers }));
}

export { VoiceRoom };

export default {
  async fetch(request, env) {
    await bootstrapDatabase(env.DB);

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        app: env.APP_NAME ?? "Edge Voice Rooms",
        timestamp: new Date().toISOString()
      });
    }

    if (request.method === "POST" && url.pathname === "/api/rooms") {
      return handleCreateRoom(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/ice-servers") {
      return handleIceServers(env);
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)$/i);
    if (request.method === "GET" && roomMatch) {
      return handleGetRoom(request, env, roomMatch[1]);
    }

    const socketMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/ws$/i);
    if (request.method === "GET" && socketMatch) {
      return handleRoomSocket(request, env, socketMatch[1]);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return errorResponse(404, "Route not found.");
  }
};
