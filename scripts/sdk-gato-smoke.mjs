import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createApp } from '../server/index.mjs';
import { prepareSDK } from '../server/sdk/bootstrap.mjs';

function checkSWI() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.SWIPL_PATH || 'swipl', ['--version'], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000,
    });
    let text = '', bytes = 0;
    const fail = () => { child.kill(); reject(new Error('SWI-Prolog no está disponible; revisar SWIPL_PATH.')); };
    child.on('error', fail);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 65536) return fail();
      text += chunk.toString();
    });
    child.stderr.on('data', () => {});
    child.on('close', (code) => code === 0 && /SWI-Prolog/i.test(text) ? resolve() : fail());
  });
}

/** Manual only. Runs the authentic installed plugin, not a fixture or the historical class. */
export async function runGatoSmoke({ goURL = process.env.GAMESTATS_URL ?? 'http://127.0.0.1:8080', difficulty = 'hard', timeoutMs = 15000 } = {}) {
  const url = new URL(goURL);
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'Go URL inválida');
  assert.ok(['easy', 'medium', 'hard'].includes(difficulty), 'Dificultad inválida');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 60000, 'timeout-ms: 1000–60000');
  const statsURL = url.href.replace(/\/+$/, '');
  await checkSWI();
  async function external(route) {
    const r = await fetch(statsURL + route, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    assert.equal(r.status, 200, `Go${route}: HTTP ${r.status}; se requieren servicios previamente iniciados`);
    return r.json();
  }
  assert.equal((await external('/health')).status, 'ok');
  assert.equal((await external('/dashboard')).source, 'GameStats / Scala');
  const sdk = await prepareSDK({ pluginsDirectory: fileURLToPath(new URL('../plugins/', import.meta.url)), trustedIds: ['tic-tac-toe'] });
  const trace = new Map(); // Diagnostic sent-event IDs, not another transport queue.
  const app = createApp({ sdk, statsURL, statsFetcher: async (target, init) => {
    if (target === statsURL + '/events' && init?.method === 'POST') {
      const event = JSON.parse(init.body); trace.set(event.eventId, event);
    }
    return fetch(target, init);
  } });
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${app.server.address().port}/api/sdk/`;
    async function request(route, body, expected = 200) {
      let r;
      try {
        r = await fetch(base + route, { signal: AbortSignal.timeout(timeoutMs), ...(body === undefined ? {} : {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }) });
      } catch { throw new Error(`${route}: resultado HTTP desconocido; no se afirma rollback. Consultar snapshot/reusar requestId con cuidado.`); }
      assert.equal(r.status, expected, `${route}: HTTP ${r.status}; comprobación real fallida`);
      return r.json();
    }
    const created = await request('matches', { gameId: 'tic-tac-toe', options: { difficulty } }, 201);
    console.log(`Gato SDK auténtico: matchId=${created.matchId}; se crean eventos reales de prueba.`);
    const route = `matches/${created.matchId}`;
    async function verify(snapshot) {
      try { await app.outbox.flush(timeoutMs); }
      catch { throw new Error('Entrega remota no confirmada; no se declaran métricas actualizadas.'); }
      const state = snapshot.state === 'finished' ? 'closed' : 'open';
      const sent = [...trace.values()].filter((e) => e.matchId === created.matchId);
      const remote = await external(`/matches/tic-tac-toe/${created.matchId}`);
      assert.equal(remote.gameId, 'tic-tac-toe'); assert.equal(remote.matchId, created.matchId); assert.equal(remote.state, state);
      assert.equal(remote.eventCount, sent.length); assert.deepEqual(remote.eventIds, sent.map((e) => e.eventId));
      assert.equal(new Set(remote.eventIds).size, remote.eventCount);
      assert.equal(sent.length, 1 + snapshot.data.turn + Math.floor(snapshot.data.turn / 2) + (state === 'closed' ? 1 : 0));
      assert.equal(sent[0].type, 'MATCH_STARTED');
      assert.deepEqual(sent[0].data, { symbols: { human: 'X', prolog: 'O' }, difficulty, players: ['human', 'prolog'] });
      const result = await request(route + '/results');
      assert.equal(result.gameId, 'tic-tac-toe'); assert.equal(result.matchId, created.matchId); assert.equal(result.state, state);
      function row(id, scope, subject) {
        const rows = result.metrics.filter((m) => m.id === id && m.scope === scope && m.subjectId === subject);
        assert.equal(rows.length, 1, `${id}: falta el perfil Gato o hay resultados repetidos`);
        const m = rows[0];
        assert.equal(m.basis?.eventCount, sent.length); assert.equal(m.basis?.lastEventId, remote.eventIds.at(-1));
        assert.equal(m.source?.profileVersion, '1.0.0');
        return m;
      }
      for (const [id, scope, subject, value] of [
        ['moves.match', 'match', created.matchId, snapshot.data.turn],
        ['moves.player', 'player', 'human', Math.ceil(snapshot.data.turn / 2)],
        ['moves.player', 'player', 'prolog', Math.floor(snapshot.data.turn / 2)],
      ]) {
        const m = row(id, scope, subject);
        assert.equal(m.value, value); assert.equal(m.unit, 'events'); assert.equal(m.status, state === 'open' ? 'provisional' : 'final');
        assert.equal(m.source.templateId, 'event-metrics/v1'); assert.equal(m.source.instanceId, 'moves');
      }
      const board = row('board.result', 'match', created.matchId);
      assert.equal(board.source.analyzerId, 'tic-tac-toe-line/v1'); assert.equal(board.source.instanceId, 'board');
      assert.equal(board.unit, 'result');
      if (snapshot.data.result === null && state === 'closed') {
        assert.equal(board.status, 'unavailable'); assert.equal(board.reason, 'insufficient_evidence'); assert.equal(board.value, null);
      } else {
        assert.equal(board.status, state === 'open' ? 'provisional' : 'final');
        assert.deepEqual(board.value, { outcome: snapshot.data.result === null ? 'in_progress' : snapshot.data.result === 'draw' ? 'draw' : 'win',
          winnerId: snapshot.data.result === 'human_won' ? 'human' : snapshot.data.result === 'prolog_won' ? 'prolog' : null });
      }
      const duration = row('duration.match', 'match', created.matchId);
      assert.equal(duration.source.templateId, 'duration/v1'); assert.equal(duration.unit, 'seconds');
      if (state === 'closed') { assert.equal(duration.status, 'final'); assert.ok(Number.isFinite(duration.value) && duration.value >= 0); }
      else { assert.equal(duration.status, 'unavailable'); assert.equal(duration.reason, 'awaiting_finish'); }
      console.log(`OK ${state}: movimientos=${snapshot.data.turn}, eventos Go=${sent.length}, resultado=${snapshot.data.result ?? 'en curso'}`);
    }
    await verify(created);
    let snapshot = created;
    for (let i = 0; snapshot.state === 'running' && i < 5; i++) {
      const input = { requestId: `gato-smoke-${i}`, type: 'PLACE_MARK', payload: { index: snapshot.data.board.indexOf('') }, expectedVersion: snapshot.version };
      const result = await request(route + '/actions', input);
      assert.equal(result.outcome, 'completed', 'La IA real o la aceptación local falló; revisar snapshot pendiente');
      assert.equal(result.committed, true);
      snapshot = result.snapshot;
      if (i === 0) {
        assert.ok(snapshot.data.lastDecision, 'No hubo una decisión auténtica de IA');
        assert.equal(snapshot.data.turn, 2);
      }
      assert.deepEqual(await request(route + '/actions', input), result, 'Replay no conserva resultado');
      await verify(snapshot);
    }
    assert.equal(snapshot.state, 'finished', 'La secuencia no terminó la partida');
    assert.ok(['human_won', 'prolog_won', 'draw'].includes(snapshot.data.result));
    assert.equal([...trace.values()].filter((e) => e.type === 'MATCH_FINISHED').length, 1);
    assert.deepEqual((await request(route + '/finish', {})).data, snapshot.data, 'Cierre repetido cambia dominio');
    await verify(snapshot);
    console.log(`PASSED: Gato plugin → Prolog real → HTTP/SDK/Outbox → Go/Scala: ${created.matchId}`);
    return { matchId: created.matchId, status: 'passed' };
  } finally {
    app.outbox.stop(); app.server.closeAllConnections();
    if (app.server.listening) await new Promise((resolve) => app.server.close(resolve));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'go-url': { type: 'string' }, difficulty: { type: 'string' }, 'timeout-ms': { type: 'string' } } });
    await runGatoSmoke({ goURL: values['go-url'] ?? process.env.GAMESTATS_URL, difficulty: values.difficulty ?? 'hard', timeoutMs: Number(values['timeout-ms'] ?? 15000) });
  } catch (error) { console.error(`Gato SDK smoke FAILED: ${error.message}`); process.exitCode = 1; }
}
