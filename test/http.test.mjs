import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/index.mjs";
test("API de consola valida juegos, origen, turnos y métodos", async (t) => {
  const app = createApp({
    statsURL: "http://127.0.0.1:1",
    ai: async () => ({ index: 4, score: 0 }),
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => {
    app.outbox.stop();
    app.server.closeAllConnections();
    app.server.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const req = (p, body) =>
    fetch(base + p, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await req("/api/matches", { gameId: "unknown" })).status, 400);
  const configured = await req("/api/matches", {
    gameId: "snake",
    options: { size: 12 },
  });
  assert.equal(configured.status, 201);
  assert.equal((await configured.json()).size, 12);
  const easy = await req("/api/matches", {
    gameId: "tic-tac-toe",
    options: { difficulty: "easy" },
  });
  assert.equal((await easy.json()).difficulty, "easy");
  for (const input of [
    null,
    [],
    { gameId: "snake", options: null },
    { gameId: "snake", options: { size: 13 } },
    { gameId: "snake", options: { size: "20" } },
    { gameId: "tic-tac-toe", options: { difficulty: "impossible" } },
  ]) {
    const count = app.matches.size;
    assert.equal((await req("/api/matches", input)).status, 400);
    assert.equal(app.matches.size, count);
  }
  const created = await req("/api/matches", { gameId: "tic-tac-toe" });
  assert.equal(created.status, 201);
  const m = await created.json();
  const moved = await req(`/api/matches/${m.id}/action`, { index: 0 });
  assert.equal(moved.status, 200);
  assert.equal((await moved.json()).board[4], "O");
  assert.equal(
    (await req(`/api/matches/${m.id}/action`, { index: 0 })).status,
    400,
  );
  assert.equal(
    (
      await fetch(base + "/api/matches", {
        headers: { Origin: "http://other-host" },
      })
    ).status,
    403,
  );
  assert.equal((await req(`/api/matches/${m.id}/finish`, {})).status, 200);
  assert.equal(
    (await req(`/api/matches/${m.id}/action`, { index: 1 })).status,
    409,
  );
});
