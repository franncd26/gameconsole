import test from "node:test";
import assert from "node:assert/strict";
import { EventOutbox } from "../server/outbox.mjs";
test("reintenta un fallo y conserva orden por partida sin bloquear otra", async () => {
  const accepted = [];
  let failed = false;
  const o = new EventOutbox("http://test", {
    retryMs: 5,
    fetcher: async (url, opts) => {
      const e = JSON.parse(opts.body);
      if (e.matchId === "a" && !failed) {
        failed = true;
        throw new Error("network");
      }
      accepted.push(e);
      return { ok: true, status: 200 };
    },
  });
  o.enqueue({ matchId: "a", eventId: "start" });
  o.enqueue({ matchId: "a", eventId: "move" });
  o.enqueue({ matchId: "b", eventId: "start" });
  await o.flush();
  assert.deepEqual(
    accepted.filter((e) => e.matchId === "a").map((e) => e.eventId),
    ["start", "move"],
  );
  assert.equal(accepted[0].matchId, "b");
  assert.equal(o.status("a").pending, 0);
  o.stop();
});
test("409 se considera entregado solo si GameStats contiene el mismo eventId", async () => {
  const o = new EventOutbox("http://test", {
    retryMs: 5,
    fetcher: async (url) =>
      url.endsWith("/events")
        ? { status: 409 }
        : { ok: true, json: async () => ({ eventIds: ["same"] }) },
  });
  o.enqueue({ gameId: "snake", matchId: "a", eventId: "same" });
  await o.flush();
  assert.equal(o.status("a").delivered, 1);
  o.stop();
});
