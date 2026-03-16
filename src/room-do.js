import { DurableObject } from "cloudflare:workers";

import { archiveRoom, markParticipantLeft, upsertParticipant, updateParticipantState } from "./db.js";
import { clampCapacity, normalizeDisplayName, normalizePeerId, toParticipantSnapshot } from "./room-utils.js";

function createJsonResponse(payload, status) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function safeParseMessage(message) {
  if (typeof message !== "string") {
    return null;
  }

  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}

export class VoiceRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.participants = new Map();

    for (const websocket of this.ctx.getWebSockets()) {
      const participant = websocket.deserializeAttachment();
      if (participant?.peerId) {
        this.participants.set(participant.peerId, {
          socket: websocket,
          participant
        });
      }
    }
  }

  async fetch(request) {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
      return createJsonResponse({ error: "Expected a WebSocket upgrade request." }, 426);
    }

    const url = new URL(request.url);
    const roomId = url.pathname.split("/")[3];
    const peerId = normalizePeerId(url.searchParams.get("peerId"));
    const displayName = normalizeDisplayName(url.searchParams.get("name"));

    if (!roomId || !peerId || !displayName) {
      return createJsonResponse({ error: "Missing roomId, peerId, or displayName." }, 400);
    }

    if (this.participants.has(peerId)) {
      const existing = this.participants.get(peerId);
      existing.socket.close(4000, "Duplicate peer id");
      this.participants.delete(peerId);
    }

    const capacity = clampCapacity(request.headers.get("x-room-capacity"), this.env);
    if (this.participants.size >= capacity) {
      return createJsonResponse({ error: "Room is full." }, 409);
    }

    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const serverSocket = pair[1];
    const joinedAt = new Date().toISOString();
    const participant = {
      roomId,
      peerId,
      displayName,
      joinedAt,
      muted: false,
      speaking: false
    };

    serverSocket.serializeAttachment(participant);
    this.ctx.acceptWebSocket(serverSocket);
    this.participants.set(peerId, {
      socket: serverSocket,
      participant
    });

    await upsertParticipant(this.env.DB, participant);

    this.send(serverSocket, {
      type: "welcome",
      roomId,
      self: toParticipantSnapshot(participant),
      peers: this.listPeers(peerId),
      capacity
    });

    this.broadcast(
      {
        type: "peer-joined",
        peer: toParticipantSnapshot(participant)
      },
      peerId
    );

    return new Response(null, {
      status: 101,
      webSocket: clientSocket
    });
  }

  async webSocketMessage(socket, rawMessage) {
    const message = safeParseMessage(rawMessage);
    const participant = socket.deserializeAttachment();

    if (!message || !participant?.peerId) {
      this.send(socket, {
        type: "error",
        message: "Invalid signaling payload."
      });
      return;
    }

    if (message.type === "heartbeat") {
      this.send(socket, {
        type: "heartbeat",
        serverTime: new Date().toISOString()
      });
      return;
    }

    if (message.type === "peer-state") {
      const updatedParticipant = {
        ...participant,
        muted: Boolean(message.muted),
        speaking: Boolean(message.speaking)
      };

      socket.serializeAttachment(updatedParticipant);
      this.participants.set(updatedParticipant.peerId, {
        socket,
        participant: updatedParticipant
      });

      await updateParticipantState(this.env.DB, updatedParticipant);

      this.broadcast(
        {
          type: "peer-updated",
          peer: toParticipantSnapshot(updatedParticipant)
        },
        updatedParticipant.peerId
      );
      return;
    }

    if (message.type === "signal") {
      const targetPeerId = normalizePeerId(message.targetPeerId);
      const target = this.participants.get(targetPeerId);

      if (!target) {
        this.send(socket, {
          type: "error",
          message: `Target peer ${targetPeerId || "unknown"} is not connected.`
        });
        return;
      }

      this.send(target.socket, {
        type: "signal",
        sourcePeerId: participant.peerId,
        signalKind: message.signalKind,
        sdp: message.sdp,
        candidate: message.candidate
      });
      return;
    }

    if (message.type === "leave") {
      socket.close(1000, "Client left the room");
      return;
    }

    this.send(socket, {
      type: "error",
      message: `Unsupported message type: ${message.type}`
    });
  }

  async webSocketClose(socket) {
    await this.disconnect(socket);
  }

  async webSocketError(socket) {
    await this.disconnect(socket);
  }

  listPeers(excludedPeerId) {
    const peers = [];

    for (const [peerId, entry] of this.participants.entries()) {
      if (peerId !== excludedPeerId) {
        peers.push(toParticipantSnapshot(entry.participant));
      }
    }

    return peers.sort((left, right) => left.joinedAt.localeCompare(right.joinedAt));
  }

  send(socket, payload) {
    socket.send(JSON.stringify(payload));
  }

  broadcast(payload, excludedPeerId) {
    const serialized = JSON.stringify(payload);

    for (const [peerId, entry] of this.participants.entries()) {
      if (peerId !== excludedPeerId) {
        entry.socket.send(serialized);
      }
    }
  }

  async disconnect(socket) {
    const participant = socket.deserializeAttachment();
    if (!participant?.peerId || !this.participants.has(participant.peerId)) {
      return;
    }

    this.participants.delete(participant.peerId);

    const leftAt = new Date().toISOString();
    await markParticipantLeft(this.env.DB, participant.roomId, participant.peerId, leftAt);

    this.broadcast(
      {
        type: "peer-left",
        peerId: participant.peerId
      },
      participant.peerId
    );

    if (this.participants.size === 0) {
      await archiveRoom(this.env, participant.roomId, leftAt);
    }
  }
}
