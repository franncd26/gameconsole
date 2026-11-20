import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { prepareSDK } from '../server/sdk/bootstrap.mjs';
import { createApp } from '../server/index.mjs';

const ids = ['tic-tac-toe', 'snake', 'racing'];
const action = (type, payload, requestId) => ({ requestId, type, payload });
const step = { lane: 2, accelerate: true, brake: false };
function gate() {
  let enter, release;
  const ready = new Promise((r) => { enter = r; });
  const wait = new Promise((r) => { release = r; });
  return { ready, release, async block() { enter(); await wait; } };
}
async function application(t) {
  const events = [];
  const sdk = await prepareSDK({ pluginsDirectory: fileURLToPath(new URL('../plugins/', import.meta.url)), trustedIds: ids });
  const app = createApp({ sdk, statsURL: 'http://go.test', statsFetcher: async (_url, init) => {
    events.push(JSON.parse(init.body)); return new Response('{}', { status: 201 });
  } });
  t.after(() => app.outbox.stop());
  return { app, events, manager: app.sdk.manager };
}

test('one real bootstrap/manager/Outbox runs all three packages together and isolates lifecycle and operations', async (t) => {
  const { app, events, manager } = await application(t);
  const matches = await Promise.all(ids.map(async (id) => {
    const prepared = await manager.create(id);
    return manager.activate(prepared.matchId);
  }));
  assert.equal(manager.size, 3); assert.equal(app.matches.size, 0);
  assert.ok(matches.every((s) => s.state === 'running')); assert.equal(new Set(matches.map((s) => s.matchId)).size, 3);
  const [gato, snake, racing] = matches;
  for (const id of ids) {
    const additional = await manager.create(id);
    assert.ok(!matches.some(s => s.matchId === additional.matchId));
    await manager.discard(additional.matchId);
  }
  const [moved, advanced] = await Promise.all([
    manager.dispatch(snake.matchId, action('TICK', { direction: 'right' }, 'parallel')),
    manager.dispatch(racing.matchId, action('STEP', step, 'parallel')),
  ]);
  assert.equal(moved.snapshot.gameId, 'snake'); assert.equal(advanced.snapshot.gameId, 'racing');
  assert.equal(moved.snapshot.version, 1); assert.equal(advanced.snapshot.version, 1);
  assert.equal(moved.snapshot.data.body[0].x, snake.data.body[0].x + 1);
  const g = gate(); t.after(g.release);
  const racingOperation = manager.runOperation(racing.matchId, async (session) => { await g.block(); return session.dispatch(action('STEP', step, 'held')); });
  await g.ready;
  const secondSnake = await manager.dispatch(snake.matchId, action('TICK', { direction: 'right' }, 'independent'));
  assert.equal(secondSnake.snapshot.version, 2, 'Snake progresses while Circuito owns its own queue');
  g.release(); assert.equal((await racingOperation).snapshot.version, 2);
  await manager.finish(snake.matchId, { reason: 'abandoned' });
  assert.equal((await manager.getSnapshot(racing.matchId)).state, 'running');
  assert.deepEqual((await manager.getSnapshot(gato.matchId)).data, gato.data, 'Gato never dispatches or calls Prolog');
  const anotherSnake = await manager.create('snake'); assert.notEqual(anotherSnake.matchId, snake.matchId);
  await manager.discard(anotherSnake.matchId);
  await app.outbox.flush(1000);
  const identity = new Map(matches.map((s) => [s.matchId, s.gameId]));
  for (const e of events) {
    assert.equal(e.gameId, identity.get(e.matchId)); assert.equal(e.schemaVersion, 1); assert.equal(e.gameVersion, '1.1.0');
  }
  assert.equal(new Set(events.map((e) => e.eventId)).size, events.length);
  assert.equal(events.filter((e) => e.type === 'MATCH_STARTED').length, 3);
  assert.deepEqual(events.filter((e) => e.type === 'MATCH_FINISHED').map((e) => e.gameId), ['snake']);
});

test('generic HTTP catalog/create/snapshot/actions/replay/close work for three authentic packages without Prolog', async (t) => {
  const { app, events } = await application(t);
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)); });
  const base = `http://127.0.0.1:${app.server.address().port}/api/sdk/`;
  const request = async (route, body) => {
    const r = await fetch(base + route, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const catalog = await request('catalog');
  assert.deepEqual(catalog.body.map((m) => m.id), ['racing', 'snake', 'tic-tac-toe']);
  assert.ok(!/entrypoints|directory|profile\.json/.test(JSON.stringify(catalog.body)));
  const matches = await Promise.all(ids.map(async (id) => {
    const r = await request('matches', { gameId: id }); assert.equal(r.status, 201); return r.body;
  }));
  const [gato, snake, racing] = matches;
  const tick = action('TICK', { direction: 'right' }, 'same-id');
  const drive = action('STEP', step, 'same-id');
  const [snakeResult, racingResult] = await Promise.all([
    request(`matches/${snake.matchId}/actions`, tick), request(`matches/${racing.matchId}/actions`, drive),
  ]);
  assert.equal(snakeResult.status, 200); assert.equal(racingResult.status, 200);
  assert.equal(snakeResult.body.snapshot.version, 1); assert.equal(racingResult.body.snapshot.version, 1);
  assert.deepEqual((await request(`matches/${snake.matchId}/actions`, tick)).body, snakeResult.body);
  assert.deepEqual((await request(`matches/${racing.matchId}/actions`, drive)).body, racingResult.body);
  assert.equal((await request('matches')).body.length, 3);
  assert.equal((await request(`matches/${snake.matchId}`)).body.data.body[0].x, snake.data.body[0].x + 1);
  for (const match of matches) assert.equal((await request(`matches/${match.matchId}`)).body.matchId, match.matchId);
  assert.equal((await request('matches')).body.length, 3, 'reading existing identities never creates another session');
  assert.equal((await request(`matches/${snake.matchId}/finish`, { reason: 'abandoned' })).body.state, 'finished');
  assert.equal((await request(`matches/${racing.matchId}`)).body.state, 'running');
  assert.equal((await request(`matches/${gato.matchId}`)).body.state, 'running');
  await app.outbox.flush(1000);
  assert.equal(events.filter((e) => e.gameId === 'tic-tac-toe').length, 1, 'Gato only started: no AI process or action');
  assert.equal(events.filter((e) => e.type === 'MATCH_FINISHED').length, 1);
});
