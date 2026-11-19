import test from "node:test";
import assert from "node:assert/strict";
import { TicTacToe, Snake, Racing } from "../server/games.mjs";
import { decide } from "../server/prolog.mjs";
const sink = () => {};
test("Gato aplica cada dificultad mediante Prolog real y puede ganarse en baja", async () => {
  const easy = new TicTacToe(sink, decide, { difficulty: "easy" });
  await easy.action({ index: 4 });
  await easy.action({ index: 2 });
  await easy.action({ index: 6 });
  assert.equal(easy.result, "human_won");
  assert.equal(easy.lastDecision.algorithm, "reglas_basicas");
  const medium = new TicTacToe(sink, decide, { difficulty: "medium" });
  await medium.action({ index: 0 });
  assert.equal(medium.board[4], "O");
  assert.equal(medium.lastDecision.algorithm, "reglas_tacticas");
  assert.equal(medium.events[0].data.difficulty, "medium");
  assert.throws(() => new TicTacToe(sink, decide, { difficulty: "other" }));
});
test("Snake adapta posiciones, comida y paredes a cada tamaño", async () => {
  for (const size of [12, 20, 28]) {
    const g = new Snake(sink, () => 0, { size });
    assert.equal(g.snapshot().size, size);
    assert.ok(
      g.body.every((p) => p.x >= 0 && p.y >= 0 && p.x < size && p.y < size),
    );
    assert.ok(g.food.x < size && g.food.y < size);
    assert.equal(g.events[0].data.gridSize, size);
    for (let i = 0; i < size && g.state === "open"; i++)
      await g.action({ direction: "right" });
    assert.equal(g.result, "game_over");
  }
  for (const size of [0, 10, 13, 100, "20", null])
    assert.throws(() => new Snake(sink, Math.random, { size }));
});
test("Gato ejecuta Prolog real y emite jugada y decisión compatibles", async () => {
  const events = [];
  const g = new TicTacToe((e) => events.push(e), decide);
  await g.action({ index: 0 });
  assert.equal(g.board[4], "O");
  assert.equal(g.turn, 2);
  assert.deepEqual(
    events.map((e) => e.type),
    ["MATCH_STARTED", "MOVE_PLACED", "AI_DECISION", "MOVE_PLACED"],
  );
  assert.equal(events[3].data.turn, 2);
  assert.equal(events[3].playerId, "prolog");
  await assert.rejects(() => g.action({ index: 4 }));
});
test("fallo de Prolog conserva turno humano y permite reintentar IA", async () => {
  let failed = true;
  const g = new TicTacToe(sink, async () => {
    if (failed) throw new Error("offline");
    return { index: 4, score: 0 };
  });
  await assert.rejects(() => g.action({ index: 0 }));
  assert.equal(g.turn, 1);
  failed = false;
  await g.action({ retryAI: true });
  assert.equal(g.turn, 2);
  assert.equal(g.board[0], "X");
});
test("partidas independientes y cierre único", async () => {
  const a = new Snake(sink),
    b = new Snake(sink);
  await a.action({ direction: "up" });
  assert.notDeepEqual(a.body, b.body);
  assert.notEqual(a.id, b.id);
  a.finish("abandoned");
  a.finish();
  assert.equal(a.events.filter((e) => e.type === "MATCH_FINISHED").length, 1);
  await assert.rejects(() => a.action({}));
});
test("Snake consume manzana con incremento y detecta pared", async () => {
  const g = new Snake(sink);
  g.food = { x: 7, y: 10 };
  await g.action({ direction: "right" });
  assert.equal(g.points, 10);
  assert.equal(g.body.length, 4);
  assert.equal(g.events[1].data.points, 10);
  while (g.state === "open") await g.action({ direction: "right" });
  assert.equal(g.events.at(-2).type, "PLAYER_DIED");
  assert.equal(g.events.at(-1).type, "MATCH_FINISHED");
});
test("Snake no puede invertir dirección sobre su cuerpo", async () => {
  const g = new Snake(sink);
  await g.action({ direction: "left" });
  assert.equal(g.direction, "right");
  assert.equal(g.body[0].x, 7);
});
test("Carreras produce tres vueltas con duraciones reales y cierre", async () => {
  let now = 1000;
  const events = [];
  const g = new Racing(
    (e) => events.push(e),
    () => now,
  );
  for (let i = 0; i < 500 && g.state === "open"; i++) {
    now += 250;
    await g.action({ accelerate: true, lane: 2 });
  }
  assert.equal(g.lap, 3);
  assert.equal(g.state, "closed");
  assert.equal(events.filter((e) => e.type === "LAP_COMPLETED").length, 3);
  assert.ok(g.lapTimes.every((t) => t > 0));
});
test("cambios de partidas concurrentes no mezclan eventos", async () => {
  const events = [];
  const games = Array.from(
    { length: 12 },
    () => new Snake((e) => events.push(e)),
  );
  await Promise.all(
    games.map((g) => g.exclusive(() => g.action({ direction: "up" }))),
  );
  for (const g of games) {
    assert.ok(g.events.every((e) => e.matchId === g.id));
    assert.equal(g.body[0].y, 9);
  }
});
