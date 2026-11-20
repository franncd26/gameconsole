import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createFixtureTransport } from '../test/helpers/sdk-transport.mjs';

function checkResults(result, match, { state, eventCount, laps, durationMs }) {
  assert.equal(result.gameId, 'racing', 'GET /results devolvió otro gameId');
  assert.equal(result.matchId, match.matchId, 'GET /results devolvió otra partida');
  assert.equal(result.state, state, 'state de resultados no corresponde al paso verificado');
  assert.ok(Array.isArray(result.metrics) && Array.isArray(result.patterns), 'metrics/patterns deben ser arrays');
  const live = state === 'open';
  const row = (id, scope, subjectId) => {
    const rows = result.metrics.filter((metric) => metric.id === id && metric.scope === scope && metric.subjectId === subjectId);
    assert.equal(rows.length, 1, `Falta o se repite la métrica racing ${id}/${subjectId}; revisar perfil Scala`);
    const metric = rows[0];
    assert.equal(metric.basis?.eventCount, eventCount, `${id}: basis.eventCount incorrecto`);
    assert.equal(metric.basis?.lastEventId, match.eventIds.at(-1), `${id}: basis.lastEventId incorrecto`);
    assert.equal(metric.source?.profileVersion, '1.0.0', `${id}: profileVersion inesperado`);
    assert.equal(metric.source?.templateId, id === 'duration.match' ? 'duration/v1' : 'event-metrics/v1');
    assert.equal(metric.source?.instanceId, id === 'duration.match' ? 'duration' : 'laps');
    return metric;
  };
  for (const [id, scope, subjectId, value, unit] of [
    ['laps.match', 'match', match.matchId, laps, 'events'],
    ['laps.player', 'player', 'p1', laps, 'events'],
    ['lap_time.total.player', 'player', 'p1', durationMs, 'ms'],
  ]) {
    const metric = row(id, scope, subjectId);
    assert.equal(metric.value, value, `${id}: valor no refleja los eventos entregados`);
    assert.equal(metric.unit, unit);
    assert.equal(metric.status, live ? 'provisional' : 'final');
  }
  const average = row('lap_time.avg.player', 'player', 'p1');
  assert.equal(average.unit, 'ms');
  assert.equal(average.value, laps === 0 ? null : durationMs / laps);
  assert.equal(average.status, laps === 0 ? 'unavailable' : live ? 'provisional' : 'final');
  if (laps === 0) assert.equal(average.reason, 'no_samples');
  const elapsed = row('duration.match', 'match', match.matchId);
  assert.equal(elapsed.unit, 'seconds');
  if (live) {
    assert.equal(elapsed.status, 'unavailable');
    assert.equal(elapsed.value, null);
    assert.equal(elapsed.reason, 'awaiting_finish');
  } else {
    assert.equal(elapsed.status, 'final');
    assert.ok(typeof elapsed.value === 'number' && Number.isFinite(elapsed.value) && elapsed.value >= 0);
  }
}

export async function runSmoke({ goURL = process.env.GAMESTATS_URL ?? 'http://127.0.0.1:8080', timeoutMs = 15000 } = {}) {
  const url = new URL(goURL);
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
    'La URL de Go debe ser HTTP(S), sin credenciales, query ni fragmento');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 60000, 'timeout-ms debe estar entre 1000 y 60000');
  const base = url.href.replace(/\/+$/, '');
  async function get(route, stage) {
    let response;
    try { response = await fetch(`${base}${route}`, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw new Error(`${stage}: no se pudo contactar Go dentro del plazo. No se inicia ningún servicio automáticamente.`); }
    if (response.status !== 200) {
      throw new Error(`${stage}: HTTP ${response.status}. Verifica Go, SCALA_SERVICE_URL y Scala (502/503/504 indican análisis no disponible).`);
    }
    try { return await response.json(); }
    catch { throw new Error(`${stage}: cuerpo JSON inválido o lectura interrumpida por red/plazo`); }
  }
  // Read-only preflight: /health alone proves only Go. /dashboard invokes the configured Scala service.
  assert.equal((await get('/health', 'Preflight Go')).status, 'ok');
  assert.equal((await get('/dashboard', 'Preflight Go → Scala')).source, 'GameStats / Scala', 'El dashboard no acredita el puente a Scala');
  const { manager, outbox } = await createFixtureTransport({ goURL: base, retryMs: 100 });
  let matchId;
  async function verify(state, eventCount, laps, durationMs) {
    try { await outbox.flush(timeoutMs); }
    catch {
      const status = outbox.status(matchId);
      throw new Error(`Entrega no confirmada de ${matchId}: pendientes=${status.pending}, entregados=${status.delivered}; ${status.error ?? 'sin respuesta'}`);
    }
    assert.deepEqual(outbox.status(matchId), { pending: 0, delivered: eventCount, error: null });
    const route = `/racing/${encodeURIComponent(matchId)}`;
    const match = await get(`/matches${route}`, 'Inspección de entrega Go');
    assert.equal(match.gameId, 'racing');
    assert.equal(match.matchId, matchId);
    assert.equal(match.state, state);
    assert.equal(match.eventCount, eventCount);
    assert.ok(Array.isArray(match.eventIds) && match.eventIds.length === eventCount && new Set(match.eventIds).size === eventCount,
      'Go debe conservar IDs únicos y el conteo esperado');
    checkResults(await get(`/results${route}`, 'Análisis Go → Scala'), match, { state, eventCount, laps, durationMs });
    console.log(`OK ${state}: eventos=${eventCount}, vueltas=${laps}, acumulado=${durationMs} ms`);
  }
  try {
    const prepared = await manager.create('racing');
    matchId = prepared.matchId;
    console.log(`Fixture SDK racing: matchId=${matchId}; esta ejecución crea una partida de prueba nueva.`);
    assert.equal((await manager.activate(matchId)).state, 'running');
    await verify('open', 1, 0, 0);
    const result = await manager.dispatch(matchId, {
      requestId: 'lap-1', type: 'COMPLETE_LAP', payload: { durationMs: 1234 }, expectedVersion: 0,
    });
    assert.equal(result.outcome, 'completed');
    assert.equal(result.committed, true);
    assert.equal(result.snapshot.version, 1);
    await verify('open', 2, 1, 1234);
    assert.equal((await manager.finish(matchId, { reason: 'smoke_completed' })).state, 'finished');
    await verify('closed', 3, 1, 1234);
    console.log(`PASSED: SDK → Outbox → Go → Scala comprobado para ${matchId}`);
    return { gameId: 'racing', matchId, status: 'passed' };
  } finally {
    outbox.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'go-url': { type: 'string' }, 'timeout-ms': { type: 'string' } } });
    await runSmoke({ goURL: values['go-url'] ?? process.env.GAMESTATS_URL, timeoutMs: Number(values['timeout-ms'] ?? 15000) });
  } catch (error) {
    console.error(`SDK transport smoke FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
