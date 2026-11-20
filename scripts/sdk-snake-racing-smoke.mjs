import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createApp } from '../server/index.mjs';
import { prepareSDK } from '../server/sdk/bootstrap.mjs';

// Manual HTTP controller only, not a runtime simulator: plan a simple path to the visible first apple.
function pathToApple({ size, body, food, direction }) {
  const vectors = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  const key = (p) => `${p.x},${p.y}`;
  const blocked = new Set(body.slice(1).map(key)), seen = new Set([key(body[0])]);
  const queue = [{ ...body[0], steps: [] }];
  for (let n = 0; n < queue.length; n++) {
    const cell = queue[n];
    if (cell.x === food.x && cell.y === food.y) return cell.steps;
    for (const [name, [dx, dy]] of Object.entries(vectors)) {
      const previous = vectors[direction];
      if (!cell.steps.length && previous[0] + dx === 0 && previous[1] + dy === 0) continue;
      const next = { x: cell.x + dx, y: cell.y + dy };
      if (next.x < 0 || next.y < 0 || next.x >= size || next.y >= size || blocked.has(key(next)) || seen.has(key(next))) continue;
      seen.add(key(next)); queue.push({ ...next, steps: [...cell.steps, name] });
    }
  }
  throw new Error('No existe ruta simple segura a la primera manzana; no se afirma consumo.');
}

/** Optional manual run: real Go/Scala must already be running. Never starts Docker or Prolog. */
export async function runSnakeRacingSmoke({ goURL = process.env.GAMESTATS_URL ?? 'http://127.0.0.1:8080', timeoutMs = 15000 } = {}) {
  const url = new URL(goURL);
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'URL Go inválida');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 60000, 'timeout-ms: 1000–60000');
  const statsURL = url.href.replace(/\/+$/, '');
  async function getGo(route) {
    const r = await fetch(statsURL + route, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    assert.equal(r.status, 200, `Go ${route}: HTTP ${r.status}; verificar servicios previamente iniciados`);
    return r.json();
  }
  assert.equal((await getGo('/health')).status, 'ok');
  assert.equal((await getGo('/dashboard')).source, 'GameStats / Scala');
  const trace = new Map(); // Diagnostic event identities only. The actual Outbox remains the sole transport.
  const sdk = await prepareSDK({ pluginsDirectory: fileURLToPath(new URL('../plugins/', import.meta.url)), trustedIds: ['snake', 'racing'] });
  const app = createApp({ sdk, statsURL, statsFetcher: async (target, init) => {
    if (target === statsURL + '/events' && init?.method === 'POST') {
      const event = JSON.parse(init.body); trace.set(event.eventId, event);
    }
    return fetch(target, init);
  } });
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${app.server.address().port}/api/sdk/`;
    async function request(route, body, status = 200) {
      let r;
      try {
        r = await fetch(base + route, { signal: AbortSignal.timeout(timeoutMs), ...(body === undefined ? {} : {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }) });
      } catch { throw new Error(`${route}: resultado HTTP desconocido; consultar snapshot/reusar requestId cuidadosamente, sin afirmar rollback.`); }
      assert.equal(r.status, status, `${route}: HTTP ${r.status}; comprobación incompleta`);
      return r.json();
    }
    const [snakeCreated, racingCreated] = await Promise.all([
      request('matches', { gameId: 'snake', options: { size: 12 } }, 201), request('matches', { gameId: 'racing' }, 201),
    ]);
    let snake = snakeCreated, racing = racingCreated, serial = 0;
    console.log(`Snake=${snake.matchId}; Circuito=${racing.matchId}. Se crean datos reales de prueba.`);
    assert.equal(snake.state, 'running'); assert.equal(racing.state, 'running');
    const route = (s) => `matches/${s.matchId}`;
    async function dispatch(s, type, payload, replay = false) {
      const input = { requestId: `smoke-${++serial}`, type, payload, expectedVersion: s.version };
      const result = await request(route(s) + '/actions', input);
      assert.equal(result.outcome, 'completed'); assert.equal(result.committed, true);
      if (replay) assert.deepEqual(await request(route(s) + '/actions', input), result, 'Replay alteró el resultado');
      return result.snapshot;
    }
    async function results(s) {
      try { await app.outbox.flush(timeoutMs); }
      catch { throw new Error('Entrega remota no confirmada; no se declaran métricas actualizadas.'); }
      const sent = [...trace.values()].filter((e) => e.matchId === s.matchId);
      const remote = await getGo(`/matches/${s.gameId}/${s.matchId}`);
      const state = s.state === 'finished' ? 'closed' : 'open';
      assert.equal(remote.gameId, s.gameId); assert.equal(remote.matchId, s.matchId); assert.equal(remote.state, state);
      assert.equal(remote.eventCount, sent.length); assert.deepEqual(remote.eventIds, sent.map((e) => e.eventId));
      assert.equal(new Set(remote.eventIds).size, sent.length);
      assert.equal(sent[0].type, 'MATCH_STARTED'); assert.deepEqual(sent[0].data.players, ['human']);
      assert.equal(sent.filter((e) => e.type === 'MATCH_FINISHED').length, state === 'closed' ? 1 : 0);
      for (const e of sent) { assert.equal(e.gameId, s.gameId); assert.equal(e.gameVersion, '1.1.0'); }
      const analytical = await request(route(s) + '/results');
      assert.equal(analytical.gameId, s.gameId); assert.equal(analytical.matchId, s.matchId); assert.equal(analytical.state, state);
      function row(id, scope, subject, template, instance) {
        const rows = analytical.metrics.filter((m) => m.id === id && m.scope === scope && m.subjectId === subject);
        assert.equal(rows.length, 1, `Métrica ausente/repetida: ${id}`);
        const m = rows[0];
        assert.equal(m.basis?.eventCount, sent.length); assert.equal(m.basis?.lastEventId, remote.eventIds.at(-1));
        assert.equal(m.source?.profileVersion, '1.0.0'); assert.equal(m.source?.templateId, template); assert.equal(m.source?.instanceId, instance);
        return m;
      }
      const final = state === 'closed';
      const duration = row('duration.match', 'match', s.matchId, 'duration/v1', 'duration');
      assert.equal(duration.unit, 'seconds');
      if (final) { assert.equal(duration.status, 'final'); assert.ok(Number.isFinite(duration.value) && duration.value >= 0); }
      else { assert.equal(duration.value, null); assert.equal(duration.status, 'unavailable'); assert.equal(duration.reason, 'awaiting_finish'); }
      return { analytical, row, sent, final };
    }
    async function verifySnake(s) {
      const { analytical, row, sent, final } = await results(s);
      const apples = sent.filter((e) => e.type === 'APPLE_EATEN'), deaths = sent.filter((e) => e.type === 'PLAYER_DIED');
      assert.equal(s.data.points, apples.length * 10);
      for (const e of apples) { assert.equal(e.playerId, 'human'); assert.deepEqual(e.data, { points: 10 }); }
      for (const [id, scope, subject, value, unit] of [
        ['apples.match', 'match', s.matchId, apples.length, 'events'],
        ['apples.player', 'player', 'human', apples.length, 'events'],
        ['points.player', 'player', 'human', apples.length * 10, 'points'],
        ['deaths.player', 'player', 'human', deaths.length, 'events'],
      ]) {
        const m = row(id, scope, subject, 'event-metrics/v1', 'apples');
        assert.equal(m.value, value); assert.equal(m.unit, unit); assert.equal(m.status, final ? 'final' : 'provisional');
      }
      const avg = row('points_per_apple.player', 'player', 'human', 'event-metrics/v1', 'apples');
      assert.equal(avg.value, apples.length ? 10 : null); assert.equal(avg.unit, 'points/apple');
      assert.equal(avg.status, apples.length ? final ? 'final' : 'provisional' : 'unavailable');
      if (!apples.length) assert.equal(avg.reason, 'no_samples');
      const lifetime = row('lifetime.player', 'player', 'human', 'duration/v1', 'lifetime');
      assert.equal(lifetime.unit, 'seconds');
      if (deaths.length) { assert.equal(lifetime.status, final ? 'final' : 'provisional'); assert.ok(Number.isFinite(lifetime.value) && lifetime.value >= 0); }
      else { assert.equal(lifetime.status, 'unavailable'); assert.equal(lifetime.reason, 'awaiting_end'); }
      const burstRows = analytical.patterns.filter((p) => p.id === 'apples.burst' && p.scope === 'player' && p.subjectId === 'human');
      assert.equal(burstRows.length, 1);
      const burst = burstRows[0];
      assert.equal(burst.source?.templateId, 'temporal-window/v1'); assert.equal(burst.source?.instanceId, 'burst');
      assert.equal(burst.source?.profileVersion, '1.0.0'); assert.equal(burst.basis?.eventCount, sent.length);
      assert.equal(burst.basis?.lastEventId, sent.at(-1).eventId); assert.equal(burst.status, final ? 'final' : 'provisional');
      assert.ok(Number.isInteger(burst.count) && burst.count >= 0 && burst.count <= Math.floor(apples.length / 3));
      assert.equal(burst.occurrences.length, burst.count);
      if (apples.length < 3) assert.equal(burst.count, 0);
      console.log(`OK Snake ${final ? 'closed' : 'open'}: manzanas=${apples.length}, puntos=${s.data.points}, muertes=${deaths.length}`);
    }
    async function verifyRacing(s) {
      const { row, sent, final } = await results(s);
      const laps = sent.filter((e) => e.type === 'LAP_COMPLETED');
      assert.deepEqual(laps.map((e) => e.data.lap), Array.from({ length: s.data.lap }, (_, i) => i + 1));
      assert.deepEqual(laps.map((e) => e.data.durationMs), s.data.lapTimes);
      assert.ok(s.data.lapTimes.every((n) => Number.isSafeInteger(n) && n > 0));
      for (const [id, scope, subject, value, unit] of [
        ['laps.match', 'match', s.matchId, s.data.lap, 'events'], ['laps.player', 'player', 'human', s.data.lap, 'events'],
        ['lap_time.total.player', 'player', 'human', s.data.lapTimes.reduce((a, b) => a + b, 0), 'ms'],
      ]) {
        const m = row(id, scope, subject, 'event-metrics/v1', 'laps');
        assert.equal(m.value, value); assert.equal(m.unit, unit); assert.equal(m.status, final ? 'final' : 'provisional');
      }
      const avg = row('lap_time.avg.player', 'player', 'human', 'event-metrics/v1', 'laps');
      assert.equal(avg.unit, 'ms'); assert.equal(avg.status, s.data.lap ? final ? 'final' : 'provisional' : 'unavailable');
      if (!s.data.lap) { assert.equal(avg.value, null); assert.equal(avg.reason, 'no_samples'); }
      else {
        const expected = s.data.lapTimes.reduce((a, b) => a + b, 0) / s.data.lap;
        assert.ok(Number.isFinite(avg.value), 'El promedio de Scala debe ser numérico');
        assert.ok(Math.abs(avg.value - expected) <= 0.000001, 'Promedio Scala no refleja vueltas aceptadas');
      }
      console.log(`OK Circuito ${final ? 'closed' : 'open'}: vueltas=${s.data.lap}`);
    }
    await verifySnake(snake); await verifyRacing(racing);
    const plan = pathToApple(snake.data);
    assert.ok(plan.length > 0 && plan.length < snake.data.size ** 2, 'Ruta inicial no acotada');
    for (const direction of plan) snake = await dispatch(snake, 'TICK', { direction }, true);
    assert.equal(snake.state, 'running'); assert.equal(snake.data.points, 10, 'No se comprobó la primera manzana real');
    await verifySnake(snake);
    for (let i = 0; i <= snake.data.size && snake.state === 'running'; i++) snake = await dispatch(snake, 'TICK', { direction: snake.data.direction });
    assert.equal(snake.state, 'finished'); assert.equal(snake.data.result, 'game_over'); await verifySnake(snake);
    assert.equal((await request(route(racing))).state, 'running', 'Terminar Snake afectó Circuito');
    const deadline = Date.now() + 240000;
    for (let i = 0; i < 800 && racing.state === 'running'; i++) {
      assert.ok(Date.now() < deadline, 'Circuito excedió el presupuesto real de cuatro minutos');
      await new Promise((resolve) => setTimeout(resolve, 250));
      const lap = racing.data.lap;
      racing = await dispatch(racing, 'STEP', { lane: racing.data.progress < 650 ? 2 : 0, accelerate: true, brake: false }, true);
      if (racing.data.lap !== lap) {
        if (racing.data.lap === 1) assert.equal(racing.state, 'running', 'No se verificó primera vuelta en vivo');
        await verifyRacing(racing);
      }
    }
    assert.equal(racing.state, 'finished'); assert.equal(racing.data.lap, 3); assert.equal(racing.data.result, 'race_completed');
    await request(route(snake) + '/finish', {}); await request(route(racing) + '/finish', {});
    await verifySnake(snake); await verifyRacing(racing);
    console.log(`PASSED: Snake/Circuito auténticos → HTTP/SDK/Outbox → Go/Scala. ${snake.matchId} / ${racing.matchId}`);
    return { status: 'passed', snakeMatchId: snake.matchId, racingMatchId: racing.matchId };
  } finally {
    app.outbox.stop(); app.server.closeAllConnections();
    if (app.server.listening) await new Promise((resolve) => app.server.close(resolve));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'go-url': { type: 'string' }, 'timeout-ms': { type: 'string' } } });
    await runSnakeRacingSmoke({ goURL: values['go-url'] ?? process.env.GAMESTATS_URL, timeoutMs: Number(values['timeout-ms'] ?? 15000) });
  } catch (error) { console.error(`Snake/Circuito SDK smoke FAILED: ${error.message}`); process.exitCode = 1; }
}
