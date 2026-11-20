import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createApp } from '../server/index.mjs';
import { prepareSDK } from '../server/sdk/bootstrap.mjs';

/** Manual only: starts a temporary loopback GameConsole, never Go/Scala or Docker. */
export async function runHTTPSmoke({ goURL = process.env.GAMESTATS_URL ?? 'http://127.0.0.1:8080', timeoutMs = 15000 } = {}) {
  const go = new URL(goURL);
  assert.ok(['http:', 'https:'].includes(go.protocol) && !go.username && !go.password && !go.search && !go.hash,
    'Go URL debe ser HTTP(S), sin credenciales, query ni fragmento');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 60000, 'timeout-ms: 1000–60000');
  const statsURL = go.href.replace(/\/+$/, '');
  async function getExternal(route) {
    const r = await fetch(statsURL + route, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    assert.equal(r.status, 200, `Preflight ${route}: HTTP ${r.status}; iniciar Go/Scala previamente`);
    return r.json();
  }
  assert.equal((await getExternal('/health')).status, 'ok', 'Go no está disponible');
  assert.equal((await getExternal('/dashboard')).source, 'GameStats / Scala', 'Scala no está disponible mediante Go');
  const sdk = await prepareSDK({ pluginsDirectory: fileURLToPath(new URL('../test/fixtures/sdk-transport/', import.meta.url)), trustedIds: ['racing'] });
  const app = createApp({ sdk, statsURL });
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${app.server.address().port}/api/sdk/`;
    async function request(route, body, expected = 200) {
      let r;
      try {
        r = await fetch(base + route, { ...(body === undefined ? {} : {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }), signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        throw new Error(`${route}: respuesta desconocida. No se afirma rollback; consultar snapshot/reintentar el mismo requestId si corresponde.`);
      }
      assert.equal(r.status, expected, `${route}: HTTP ${r.status}; integración no comprobada`);
      return r.json();
    }
    assert.deepEqual((await request('catalog')).map((m) => m.id), ['racing']);
    const created = await request('matches', { gameId: 'racing' }, 201);
    const route = `matches/${created.matchId}`;
    console.log(`Fixture HTTP SDK: ${created.matchId}; crea datos de prueba nuevos en Go.`);
    assert.equal(created.state, 'running');
    assert.equal((await request(route)).version, 0);
    async function verify(state, count, laps, durationMs) {
      try { await app.outbox.flush(timeoutMs); }
      catch { throw new Error('No se confirmó la entrega remota; revisar estado del Outbox y servicios.'); }
      const snapshot = await request(route);
      assert.equal(snapshot.delivery.pending, 0);
      assert.equal(snapshot.delivery.delivered, count);
      const result = await request(route + '/results');
      assert.equal(result.gameId, 'racing'); assert.equal(result.matchId, created.matchId); assert.equal(result.state, state);
      assert.ok(Array.isArray(result.patterns));
      function metric(id, scope, subjectId) {
        const rows = result.metrics.filter((m) => m.id === id && m.scope === scope && m.subjectId === subjectId);
        assert.equal(rows.length, 1, `${id}: falta o se repite una métrica del perfil real`);
        const m = rows[0];
        assert.equal(m.basis?.eventCount, count);
        assert.equal(m.source?.profileVersion, '1.0.0');
        assert.equal(m.source?.templateId, id === 'duration.match' ? 'duration/v1' : 'event-metrics/v1');
        assert.equal(m.source?.instanceId, id === 'duration.match' ? 'duration' : 'laps');
        return m;
      }
      for (const [id, scope, subject, value, unit] of [
        ['laps.match', 'match', created.matchId, laps, 'events'],
        ['laps.player', 'player', 'p1', laps, 'events'],
        ['lap_time.total.player', 'player', 'p1', durationMs, 'ms'],
      ]) {
        const m = metric(id, scope, subject);
        assert.equal(m.value, value); assert.equal(m.unit, unit);
        assert.equal(m.status, state === 'open' ? 'provisional' : 'final');
      }
      const average = metric('lap_time.avg.player', 'player', 'p1');
      assert.equal(average.unit, 'ms');
      assert.equal(average.value, laps ? durationMs / laps : null);
      assert.equal(average.status, laps ? state === 'open' ? 'provisional' : 'final' : 'unavailable');
      if (!laps) assert.equal(average.reason, 'no_samples');
      const elapsed = metric('duration.match', 'match', created.matchId);
      assert.equal(elapsed.unit, 'seconds');
      if (state === 'open') {
        assert.equal(elapsed.value, null); assert.equal(elapsed.status, 'unavailable'); assert.equal(elapsed.reason, 'awaiting_finish');
      } else {
        assert.equal(elapsed.status, 'final'); assert.ok(Number.isFinite(elapsed.value) && elapsed.value >= 0);
      }
      console.log(`OK HTTP ${state}: eventos=${count}, vueltas=${laps}`);
    }
    await verify('open', 1, 0, 0);
    const action = { requestId: 'http-lap-1', type: 'COMPLETE_LAP', payload: { durationMs: 1234 }, expectedVersion: 0 };
    const result = await request(route + '/actions', action);
    assert.equal(result.outcome, 'completed'); assert.equal(result.committed, true); assert.equal(result.snapshot.version, 1);
    await verify('open', 2, 1, 1234);
    assert.deepEqual(await request(route + '/actions', action), result);
    await verify('open', 2, 1, 1234);
    assert.equal((await request(route + '/finish', { reason: 'smoke_completed' })).state, 'finished');
    await verify('closed', 3, 1, 1234);
    console.log(`PASSED: HTTP → SDK → Outbox → Go → Scala: ${created.matchId}`);
    return { matchId: created.matchId, status: 'passed' };
  } finally {
    app.outbox.stop();
    app.server.closeAllConnections();
    if (app.server.listening) await new Promise((resolve) => app.server.close(resolve));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'go-url': { type: 'string' }, 'timeout-ms': { type: 'string' } } });
    await runHTTPSmoke({ goURL: values['go-url'] ?? process.env.GAMESTATS_URL, timeoutMs: Number(values['timeout-ms'] ?? 15000) });
  } catch (error) {
    console.error(`SDK HTTP smoke FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
