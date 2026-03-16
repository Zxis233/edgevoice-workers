import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function createRoom(title = "Signal Test") {
  const response = await SELF.fetch("http://example.com/api/rooms", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ title, capacity: 5 })
  });

  expect(response.status).toBe(201);
  return response.json();
}

async function openSocket(roomId, peerId, name) {
  const url = new URL(`http://example.com/api/rooms/${roomId}/ws`);
  url.searchParams.set("peerId", peerId);
  url.searchParams.set("name", name);

  const response = await SELF.fetch(url.toString(), {
    headers: {
      Upgrade: "websocket"
    }
  });

  expect(response.status).toBe(101);
  expect(response.webSocket).toBeDefined();

  const socket = response.webSocket;
  const queue = [];
  const waiters = [];

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    const resolve = waiters.shift();
    if (resolve) {
      resolve(payload);
      return;
    }

    queue.push(payload);
  });

  socket.accept();

  return {
    socket,
    async next(timeoutMs = 2500) {
      if (queue.length > 0) {
        return queue.shift();
      }

      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          const index = waiters.indexOf(onMessage);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error("Timed out waiting for websocket message."));
        }, timeoutMs);

        function onMessage(message) {
          clearTimeout(timeoutId);
          resolve(message);
        }

        waiters.push(onMessage);
      });
    }
  };
}

async function waitForCondition(check, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await check();
    if (result) {
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for condition.");
}

describe("voice room signaling", () => {
  it("preserves full UUID peer ids when a client joins", async () => {
    const created = await createRoom("UUID Peer");
    const uuidPeerId = "55ca1f0a-2a6c-45f4-ae45-135feceaeaf1";

    const alice = await openSocket(created.room.id, uuidPeerId, "Alice");
    const aliceWelcome = await alice.next();

    expect(aliceWelcome).toMatchObject({
      type: "welcome",
      self: {
        peerId: uuidPeerId,
        displayName: "Alice"
      }
    });

    alice.socket.close(1000, "bye");
  });

  it("relays signaling messages and archives the room when everyone leaves", async () => {
    const created = await createRoom();

    const alice = await openSocket(created.room.id, "alice-1", "Alice");
    const aliceWelcome = await alice.next();
    expect(aliceWelcome.type).toBe("welcome");
    expect(aliceWelcome.peers).toEqual([]);

    const bob = await openSocket(created.room.id, "bob-1", "Bob");
    const bobWelcome = await bob.next();
    const aliceJoined = await alice.next();

    expect(bobWelcome.type).toBe("welcome");
    expect(bobWelcome.peers).toHaveLength(1);
    expect(bobWelcome.peers[0].peerId).toBe("alice-1");
    expect(aliceJoined).toMatchObject({
      type: "peer-joined",
      peer: {
        peerId: "bob-1",
        displayName: "Bob"
      }
    });

    bob.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: "alice-1",
        signalKind: "offer",
        sdp: "fake-offer"
      })
    );

    const relayedSignal = await alice.next();
    expect(relayedSignal).toEqual({
      type: "signal",
      sourcePeerId: "bob-1",
      signalKind: "offer",
      sdp: "fake-offer"
    });

    alice.socket.send(
      JSON.stringify({
        type: "peer-state",
        muted: true,
        speaking: false
      })
    );

    const peerUpdated = await bob.next();
    expect(peerUpdated).toMatchObject({
      type: "peer-updated",
      peer: {
        peerId: "alice-1",
        muted: true,
        speaking: false
      }
    });

    bob.socket.close(1000, "bye");
    const peerLeft = await alice.next();
    expect(peerLeft).toEqual({
      type: "peer-left",
      peerId: "bob-1"
    });

    alice.socket.close(1000, "bye");

    const archiveEntry = await waitForCondition(async () => {
      const listing = await env.ROOM_ARCHIVE.list({
        prefix: `rooms/${created.room.id}/`
      });
      return listing.objects[0] ?? null;
    });

    const archiveObject = await env.ROOM_ARCHIVE.get(archiveEntry.key);
    const archivePayload = JSON.parse(await archiveObject.text());

    expect(archivePayload.room.id).toBe(created.room.id);
    expect(archivePayload.participants).toHaveLength(2);
    expect(archivePayload.participants.map((participant) => participant.peerId)).toEqual([
      "alice-1",
      "bob-1"
    ]);
  });
});
