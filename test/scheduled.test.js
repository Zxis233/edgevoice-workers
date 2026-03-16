import {
  SELF,
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index.js";

async function createRoom(title = "Scheduled Cleanup") {
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

async function runScheduled(scheduledTime, cron = "0 0 * * *") {
  const controller = createScheduledController({ cron, scheduledTime });
  const ctx = createExecutionContext();

  await worker.scheduled(controller, env, ctx);
  await waitOnExecutionContext(ctx);
}

describe("scheduled maintenance", () => {
  it("deletes empty rooms from D1 during the daily cleanup window", async () => {
    const created = await createRoom("Empty Room");

    const beforeCleanup = await SELF.fetch(`http://example.com/api/rooms/${created.room.id}`);
    expect(beforeCleanup.status).toBe(200);

    await runScheduled(Date.parse("2026-03-16T20:00:00.000Z"));

    const afterCleanup = await SELF.fetch(`http://example.com/api/rooms/${created.room.id}`);
    expect(afterCleanup.status).toBe(404);
  });

  it("keeps archived room summaries on non-Sunday runs", async () => {
    const summaryPrefix = `rooms/${crypto.randomUUID()}/`;
    const summaryKey = `${summaryPrefix}summary.json`;

    await env.ROOM_ARCHIVE.put(summaryKey, JSON.stringify({ roomId: "cleanup-target" }));

    await runScheduled(Date.parse("2026-03-16T20:00:00.000Z"));

    const preservedSummary = await env.ROOM_ARCHIVE.get(summaryKey);
    expect(await preservedSummary?.text()).toBe(JSON.stringify({ roomId: "cleanup-target" }));
  });

  it("deletes only archived room summaries on Sunday UTC+8 runs", async () => {
    const summaryPrefix = `rooms/${crypto.randomUUID()}/`;
    const summaryKey = `${summaryPrefix}summary.json`;
    const keepKey = `meta/${crypto.randomUUID()}.json`;

    await env.ROOM_ARCHIVE.put(summaryKey, JSON.stringify({ roomId: "cleanup-target" }));
    await env.ROOM_ARCHIVE.put(keepKey, JSON.stringify({ keep: true }));

    await runScheduled(Date.parse("2026-03-14T20:00:00.000Z"));

    const deletedSummary = await env.ROOM_ARCHIVE.get(summaryKey);
    const preservedObject = await env.ROOM_ARCHIVE.get(keepKey);

    expect(deletedSummary).toBeNull();
    expect(await preservedObject?.text()).toBe(JSON.stringify({ keep: true }));
  });
});
