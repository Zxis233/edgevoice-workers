import {
  bootstrapDatabase,
  createRoom,
  deleteEmptyRooms,
  getAppConfig,
  getRoom,
  updateAppConfig
} from "./db.js";
import { errorResponse, json, readJson } from "./http.js";
import { resolveIceServers } from "./ice.js";
import { VoiceRoom } from "./room-do.js";
import {
  clampCapacity,
  createRoomId,
  normalizeAppConfig,
  normalizeDisplayName,
  normalizePeerId,
  normalizeTitle,
  previewRoomId
} from "./room-utils.js";

const DEFAULT_ADMIN_TRIGGER_NAME = "admin";
const DEFAULT_ADMIN_TRIGGER_ROOM_ID = "admin-room";
const ROOM_ARCHIVE_PREFIX = "rooms/";
const UTC_PLUS_8_OFFSET_MS = 8 * 60 * 60 * 1000;

function buildJoinUrl(requestUrl, roomId) {
  const joinUrl = new URL(requestUrl.origin);
  joinUrl.searchParams.set("room", roomId);
  return joinUrl.toString();
}

function getAdminTriggerName(env) {
  const configured = normalizeDisplayName(env.ADMIN_TRIGGER_NAME);
  return configured || DEFAULT_ADMIN_TRIGGER_NAME;
}

function normalizeAdminRoomId(value) {
  return `${value ?? ""}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function getAdminTriggerRoomId(env) {
  const configured = normalizeAdminRoomId(env.ADMIN_TRIGGER_ROOM_ID);
  return configured || DEFAULT_ADMIN_TRIGGER_ROOM_ID;
}

function getAdminToken(request) {
  return normalizeDisplayName(request.headers.get("x-admin-token"));
}

function getAdminRoomId(request) {
  return normalizeAdminRoomId(request.headers.get("x-admin-room-id"));
}

function isAdminRequest(request, env) {
  return (
    getAdminToken(request) === getAdminTriggerName(env) &&
    getAdminRoomId(request) === getAdminTriggerRoomId(env)
  );
}

function buildConfigPayload(config) {
  const normalized = normalizeAppConfig(config);

  return {
    config: {
      ...normalized,
      updatedAt: config?.updatedAt ?? null
    },
    roomIdPreview: previewRoomId(normalized)
  };
}

async function createConfiguredRoom(env, title, capacity, createdAt, appConfig) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const room = await createRoom(env.DB, {
      id: createRoomId(appConfig),
      title,
      capacity,
      createdAt
    });

    if (room) {
      return room;
    }
  }

  return null;
}

async function handleCreateRoom(request, env) {
  const payload = await readJson(request);
  const appConfig = await getAppConfig(env.DB);

  if (!appConfig.allowRoomCreation) {
    return errorResponse(403, "管理员已关闭新建房间。", {
      allowRoomCreation: false
    });
  }

  const title = normalizeTitle(payload.title);
  const capacity = clampCapacity(payload.capacity, env);
  const createdAt = new Date().toISOString();
  const room = await createConfiguredRoom(env, title, capacity, createdAt, appConfig);

  if (!room) {
    return errorResponse(503, "房间 ID 生成冲突过多，请稍后重试。");
  }

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

async function deleteArchivedSummaries(bucket) {
  if (bucket === undefined) {
    return 0;
  }

  let deletedCount = 0;
  let cursor;

  do {
    const listing = await bucket.list({
      prefix: ROOM_ARCHIVE_PREFIX,
      cursor
    });

    if (listing.objects.length > 0) {
      await Promise.all(listing.objects.map((object) => bucket.delete(object.key)));
      deletedCount += listing.objects.length;
    }

    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  return deletedCount;
}

function isUtcPlus8Sunday(scheduledTime) {
  const beijingTime = new Date(Number(scheduledTime ?? Date.now()) + UTC_PLUS_8_OFFSET_MS);
  return beijingTime.getUTCDay() === 0;
}

async function handleScheduledCleanup(controller, env) {
  const deletedRooms = await deleteEmptyRooms(env.DB);
  console.log(`Scheduled empty room cleanup deleted ${deletedRooms} room(s).`);

  if (isUtcPlus8Sunday(controller.scheduledTime)) {
    const deletedSummaries = await deleteArchivedSummaries(env.ROOM_ARCHIVE);
    console.log(`Scheduled weekly R2 summary cleanup deleted ${deletedSummaries} object(s).`);
  }
}

async function handleGetAppConfig(env) {
  const config = await getAppConfig(env.DB);
  return json(buildConfigPayload(config));
}

async function handleAdminSession(request, env) {
  const payload = await readJson(request);
  const username = normalizeDisplayName(payload.username);
  const roomId = normalizeAdminRoomId(payload.roomId);

  if (
    !username ||
    !roomId ||
    username !== getAdminTriggerName(env) ||
    roomId !== getAdminTriggerRoomId(env)
  ) {
    return errorResponse(401, "管理员身份校验失败。");
  }

  const config = await getAppConfig(env.DB);
  return json(buildConfigPayload(config));
}

async function handleGetAdminConfig(request, env) {
  if (!isAdminRequest(request, env)) {
    return errorResponse(401, "未授权的管理员请求。");
  }

  const config = await getAppConfig(env.DB);
  return json(buildConfigPayload(config));
}

async function handleUpdateAdminConfig(request, env) {
  if (!isAdminRequest(request, env)) {
    return errorResponse(401, "未授权的管理员请求。");
  }

  const payload = await readJson(request);
  const config = await updateAppConfig(env.DB, {
    allowRoomCreation: payload.allowRoomCreation,
    roomNamePattern: payload.roomNamePattern,
    roomRandomLength: payload.roomRandomLength
  });

  return json(buildConfigPayload(config));
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

    if (request.method === "GET" && url.pathname === "/api/app-config") {
      return handleGetAppConfig(env);
    }

    if (request.method === "POST" && url.pathname === "/api/admin/session") {
      return handleAdminSession(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/admin/config") {
      return handleGetAdminConfig(request, env);
    }

    if (request.method === "PUT" && url.pathname === "/api/admin/config") {
      return handleUpdateAdminConfig(request, env);
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
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(handleScheduledCleanup(controller, env));
  }
};
