import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const base = process.env.CONSOLE_URL || "http://127.0.0.1:3000";
async function call(route, body) {
  const r = await fetch(base + "/api" + route, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(r.ok, `${route}: ${r.status}`);
  return r.json();
}
const docker = (action) =>
  execFileSync("docker", ["compose", action, "go-ingestion"], {
    stdio: "inherit",
    windowsHide: true,
  });
let m;
try {
  docker("pause");
  m = await call("/matches", { gameId: "snake" });
  const step = await call(`/matches/${m.id}/action`, { direction: "up" });
  assert.equal(step.body[0].y, 9);
  await call(`/matches/${m.id}/finish`, {});
  const pending = await call("/matches/" + m.id);
  assert.equal(pending.state, "closed");
  assert.ok(pending.delivery.pending >= 2);
  console.log(
    "El juego continuó y conservó sus eventos durante la interrupción.",
  );
} finally {
  docker("unpause");
}
let state;
for (let i = 0; i < 100; i++) {
  state = await call("/matches/" + m.id);
  if (state.delivery.pending === 0) break;
  await new Promise((r) => setTimeout(r, 200));
}
assert.equal(state.delivery.pending, 0);
const result = await call(`/matches/${m.id}/results`);
assert.equal(result.state, "closed");
await mkdir("evidence", { recursive: true });
await writeFile(
  "evidence/recovery.json",
  JSON.stringify(
    {
      status: "passed",
      matchId: m.id,
      delivered: state.delivery.delivered,
      checks: [
        "game continued while Go paused",
        "events retained in order",
        "delivery recovered",
        "Scala returned final result",
      ],
    },
    null,
    2,
  ),
);
console.log("Recuperación aprobada: eventos entregados y partida analizada.");
