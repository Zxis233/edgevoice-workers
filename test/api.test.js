import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function createRoom(title = "Daily Sync") {
  const response = await SELF.fetch("http://example.com/api/rooms", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      title,
      capacity: 5
    })
  });

  expect(response.status).toBe(201);
  return response.json();
}

describe("voice room api", () => {
  it("creates a room and returns metadata", async () => {
    const created = await createRoom("Product Review");

    expect(created.room.id).toMatch(/^room-[a-z0-9]{10}$/);
    expect(created.room.capacity).toBe(5);
    expect(created.joinUrl).toContain(`room=${created.room.id}`);

    const lookup = await SELF.fetch(`http://example.com/api/rooms/${created.room.id}`);
    expect(lookup.status).toBe(200);

    const payload = await lookup.json();
    expect(payload.room.title).toBe("Product Review");
    expect(payload.room.activeCount).toBe(0);
    expect(payload.room.participants).toEqual([]);
  });

  it("returns fallback ice servers when TURN secrets are absent", async () => {
    const response = await SELF.fetch("http://example.com/api/ice-servers");
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.iceServers).toHaveLength(1);
    expect(payload.iceServers[0].urls).toContain("stun:stun.cloudflare.com:3478");
  });
});
