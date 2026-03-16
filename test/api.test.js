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

  it("lets admin update app config and enforces room creation policy", async () => {
    const publicConfigResponse = await SELF.fetch("http://example.com/api/app-config");
    expect(publicConfigResponse.status).toBe(200);

    const publicConfig = await publicConfigResponse.json();
    expect(publicConfig.config.allowRoomCreation).toBe(true);
    expect(publicConfig.config.roomNamePattern).toBe("room-{random}");
    expect(publicConfig.config.roomRandomLength).toBe(10);
    expect(publicConfig.roomIdPreview).toMatch(/^room-[a-z0-9]{10}$/);

    const unauthorized = await SELF.fetch("http://example.com/api/admin/config", {
      headers: {
        "x-admin-token": "not-admin"
      }
    });
    expect(unauthorized.status).toBe(401);

    const adminSession = await SELF.fetch("http://example.com/api/admin/session", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        username: "__admin__"
      })
    });
    expect(adminSession.status).toBe(200);

    const updatedConfigResponse = await SELF.fetch("http://example.com/api/admin/config", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-admin-token": "__admin__"
      },
      body: JSON.stringify({
        allowRoomCreation: false,
        roomNamePattern: "team-{random}",
        roomRandomLength: 6
      })
    });
    expect(updatedConfigResponse.status).toBe(200);

    const updatedConfig = await updatedConfigResponse.json();
    expect(updatedConfig.config.allowRoomCreation).toBe(false);
    expect(updatedConfig.config.roomNamePattern).toBe("team-{random}");
    expect(updatedConfig.config.roomRandomLength).toBe(6);
    expect(updatedConfig.roomIdPreview).toMatch(/^team-[a-z0-9]{6}$/);

    const refreshedConfigResponse = await SELF.fetch("http://example.com/api/app-config");
    const refreshedConfig = await refreshedConfigResponse.json();
    expect(refreshedConfig.config.allowRoomCreation).toBe(false);
    expect(refreshedConfig.roomIdPreview).toMatch(/^team-[a-z0-9]{6}$/);

    const blockedCreate = await SELF.fetch("http://example.com/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "Should Not Exist",
        capacity: 5
      })
    });
    expect(blockedCreate.status).toBe(403);

    const restoredConfigResponse = await SELF.fetch("http://example.com/api/admin/config", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-admin-token": "__admin__"
      },
      body: JSON.stringify({
        allowRoomCreation: true,
        roomNamePattern: "team-{random}",
        roomRandomLength: 6
      })
    });
    expect(restoredConfigResponse.status).toBe(200);

    const created = await createRoom("Configurable ID");
    expect(created.room.id).toMatch(/^team-[a-z0-9]{6}$/);
  });
});
