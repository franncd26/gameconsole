import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/index.mjs';
import { prepareSDK, prepareSDKFromEnvironment } from '../server/sdk/bootstrap.mjs';

const fixture = new URL('./fixtures/sdk-transport/racing/', import.meta.url);
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function gate() {
  let release, entered;
  const ready = new Promise((r) => { entered = r; });
  const wait = new Promise((r) => { release = r; });
  return { ready, release, async block() { entered(); await wait; } };
}
async function installation(t, ids = ['racing', 'other-game', 'untrusted']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sdk-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const id of ids) {
    const dir = path.join(root, id);
    await mkdir(dir);
    const manifest = JSON.parse(await readFile(new URL('game.json', fixture), 'utf8'));
    manifest.id = id;
    manifest.options = [{ id: 'fail', label: 'Fallo de preparación', type: 'boolean', default: false }];
    await writeFile(path.join(dir, 'game.json'), JSON.stringify(manifest));
    await copyFile(new URL('index.html', fixture), path.join(dir, 'index.html'));
    await copyFile(new URL('server.mjs', fixture), path.join(dir, 'base.mjs'));
    if (id === 'untrusted') {
      await writeFile(path.join(dir, 'server.mjs'), "throw new Error('Untrusted module must never execute');");
    } else await copyFile(new URL('./fixtures/sdk-http/plugin.mjs', import.meta.url), path.join(dir, 'server.mjs'));
  }
  return root;
}
function fakeGo() {
  const events = [], queries = [];
  const go = { events, queries, beforeEvent: null, beforeResults: null, resultStatus: 200, malformed: false };
  go.fetch = async (url, init = {}) => {
    const p = new URL(url).pathname;
    if (p === '/events') {
      const event = JSON.parse(init.body);
      await go.beforeEvent?.(event);
      events.push(event);
      return response({ status: 'accepted' }, 201);
    }
    queries.push(p);
    await go.beforeResults?.(init.signal);
    if (go.resultStatus !== 200) return response({ error: 'C:\\private\\service.go: internal trace' }, go.resultStatus);
    if (go.rawResults !== undefined) return new Response(go.rawResults);
    const [, , gameId, matchId] = p.split('/');
    const match = events.filter((e) => e.matchId === matchId);
    const laps = match.filter((e) => e.type === 'LAP_COMPLETED');
    const closed = match.some((e) => e.type === 'MATCH_FINISHED');
    return response({ gameId: go.malformed ? 'wrong-game' : gameId, matchId, state: closed ? 'closed' : 'open',
      metrics: [{ id: 'laps.match', scope: 'match', subjectId: matchId, value: laps.length, unit: 'events',
        status: closed ? 'final' : 'provisional', basis: { eventCount: match.length, lastEventId: match.at(-1)?.eventId },
        source: { templateId: 'event-metrics/v1', instanceId: 'laps', profileVersion: '1.0.0' } }], patterns: [] });
  };
  return go;
}
async function appFor(t, { disabled = false, trustedIds = ['racing'], sdkHTTP, go = fakeGo() } = {}) {
  const root = await installation(t);
  const sdk = disabled ? undefined : await prepareSDK({ pluginsDirectory: root, trustedIds });
  const app = createApp({ sdk, statsURL: 'http://go.test', statsFetcher: go.fetch, sdkHTTP, ai: async () => ({ index: 4, score: 0 }) });
  assert.equal(typeof app.then, 'undefined', 'createApp remains synchronous');
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    app.outbox.stop();
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, body, init = {}) => {
    const res = await fetch(base + '/api/sdk/' + route, {
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), ...init,
    });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  const create = async (gameId = 'racing') => {
    const r = await request('matches', { gameId }); assert.equal(r.status, 201); return r.body;
  };
  const hooks = (await import(pathToFileURL(path.join(root, trustedIds[0], 'server.mjs')).href)).hooks;
  return { app, go, base, request, create, hooks };
}
const action = (requestId = 'lap-1', extras = {}) => ({ requestId, type: 'COMPLETE_LAP', payload: { durationMs: 1234 }, ...extras });

test('bootstrap: explicit opt-in, complete trust set, invalid/duplicate packages fail safely', async (t) => {
  assert.equal(await prepareSDKFromEnvironment({}), undefined);
  for (const env of [{ GAMECONSOLE_SDK_ENABLED: 'yes' }, { GAMECONSOLE_TRUSTED_IDS: 'racing' },
    { GAMECONSOLE_SDK_ENABLED: '1' }]) await assert.rejects(prepareSDKFromEnvironment(env), { code: 'SDK_CONFIGURATION' });
  const root = await installation(t);
  await assert.rejects(prepareSDK({ pluginsDirectory: root, trustedIds: ['missing'] }), { code: 'SDK_TRUSTED_MISSING' });
  await assert.rejects(prepareSDK({ pluginsDirectory: root, trustedIds: ['racing', 'racing'] }), { code: 'SDK_CONFIGURATION' });
  const env = { GAMECONSOLE_SDK_ENABLED: '1', GAMECONSOLE_PLUGINS_DIR: root, GAMECONSOLE_TRUSTED_IDS: 'racing, other-game' };
  assert.ok(await prepareSDKFromEnvironment(env)); // untrusted module throws if imported
  await writeFile(path.join(root, 'other-game', 'game.json'), await readFile(path.join(root, 'racing', 'game.json')));
  await assert.rejects(prepareSDKFromEnvironment(env), { code: 'SDK_DISCOVERY_FAILED' });
  await writeFile(path.join(root, 'other-game', 'game.json'), '{}');
  await assert.rejects(prepareSDKFromEnvironment(env), { code: 'SDK_DISCOVERY_FAILED' });
});

test('disabled SDK leaves historical catalog, health and creation working', async (t) => {
  const { app, base, request } = await appFor(t, { disabled: true });
  assert.equal((await request('catalog')).status, 404);
  assert.equal((await fetch(base + '/api/health')).status, 200);
  assert.equal((await (await fetch(base + '/api/catalog')).json()).length, 3);
  const res = await fetch(base + '/api/matches', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameId: 'snake', options: { size: 12 } }) });
  assert.equal(res.status, 201);
  assert.equal(app.matches.size, 1);
});

test('authorized metadata select multiple plugins generically; untrusted module never loads', async (t) => {
  const { app, request, create } = await appFor(t, { trustedIds: ['racing', 'other-game'] });
  const catalog = await request('catalog');
  assert.deepEqual(catalog.body.map((m) => m.id), ['other-game', 'racing']);
  assert.ok(!/directory|entrypoints|paths|sdk-http-|server\.mjs/.test(JSON.stringify(catalog.body)));
  assert.equal((await request('matches', { gameId: 'untrusted' })).status, 404);
  assert.equal((await create('other-game')).gameId, 'other-game');
  const running = await create();
  assert.equal(running.state, 'running');
  assert.equal(running.version, 0);
  await app.outbox.flush(1000);
  assert.equal((await request('matches')).body.length, 2);
});

test('historical and SDK routes use the same actual Outbox and transport', async (t) => {
  const { app, base, go, create } = await appFor(t);
  const sdkMatch = await create();
  const res = await fetch(base + '/api/matches', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameId: 'racing' }) });
  assert.equal(res.status, 201);
  const historical = await res.json();
  await app.outbox.flush(1000);
  assert.equal(app.matches.size, 1); assert.equal(app.sdk.manager.size, 1);
  for (const id of [sdkMatch.matchId, historical.id]) {
    assert.equal(app.outbox.status(id).delivered, 1);
    assert.equal(go.events.filter((e) => e.matchId === id && e.type === 'MATCH_STARTED').length, 1);
  }
});

test('creation validates exact body/options/participants; failures publish no active session', async (t) => {
  const { app, request, go } = await appFor(t);
  for (const input of [null, [], {}, { gameId: 'racing', extra: true }, { gameId: 'racing', options: null },
    { gameId: 'racing', options: { unknown: 1 } }, { gameId: 'racing', players: [] },
    { gameId: 'racing', players: [{ id: 'p2', role: 'human' }] }]) {
    assert.equal((await request('matches', input)).status, 400);
    assert.equal(app.sdk.manager.size, 0);
  }
  const failed = await request('matches', { gameId: 'racing', options: { fail: true } });
  assert.equal(failed.status, 502);
  assert.ok(!/private|confidential|stack|plugin\.mjs/.test(JSON.stringify(failed.body)));
  assert.equal(app.sdk.manager.size, 0);
  app.outbox.stop();
  assert.equal((await request('matches', { gameId: 'racing' })).status, 503);
  assert.equal(app.sdk.manager.size, 0);
  assert.equal(go.events.length, 0);
});

test('HTTP action/version/replay conflicts preserve original result and ordered lifecycle events', async (t) => {
  const { app, go, request, create } = await appFor(t);
  const m = await create(), route = `matches/${m.matchId}`;
  const input = action('one', { expectedVersion: 0 });
  const first = await request(route + '/actions', input);
  assert.equal(first.status, 200); assert.equal(first.body.snapshot.version, 1);
  const second = await request(route + '/actions', action('two', { expectedVersion: 1 }));
  assert.equal(second.body.snapshot.version, 2);
  assert.deepEqual((await request(route + '/actions', input)).body, first.body);
  assert.equal((await request(route + '/actions', action('one', { payload: { durationMs: 9 } }))).status, 409);
  const conflict = await request(route + '/actions', action('stale', { expectedVersion: 0 }));
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'VERSION_CONFLICT');
  assert.equal((await request(route)).body.version, 2);
  assert.equal((await request(route + '/actions', action('unknown', { type: 'UNKNOWN_GAME_ACTION' }))).status, 200);
  const finished = await request(route + '/finish', { reason: 'completed' });
  assert.equal(finished.body.state, 'finished');
  assert.equal((await request(route + '/finish', {})).body.version, finished.body.version);
  assert.deepEqual((await request(route + '/actions', input)).body, first.body, 'replay after finish returns original snapshot');
  assert.equal((await request(route + '/actions', action('new'))).status, 409);
  await app.outbox.flush(1000);
  assert.deepEqual(go.events.map((e) => e.type), ['MATCH_STARTED', 'LAP_COMPLETED', 'LAP_COMPLETED', 'MATCH_FINISHED']);
  assert.deepEqual(go.events[0].data.players, ['p1']);
});

test('canonical HTTP replay ignores object key order and keeps histories isolated by match', async (t) => {
  const { app, go, request, create } = await appFor(t);
  const a = await create(), b = await create();
  const input = { requestId: 'shared', type: 'COMPLETE_LAP', payload: { durationMs: 1234, detail: { a: 1, b: 2 } }, expectedVersion: 0 };
  const reordered = { payload: { detail: { b: 2, a: 1 }, durationMs: 1234 }, expectedVersion: 0, type: 'COMPLETE_LAP', requestId: 'shared' };
  const original = await request(`matches/${a.matchId}/actions`, input);
  assert.deepEqual((await request(`matches/${a.matchId}/actions`, reordered)).body, original.body);
  assert.equal((await request(`matches/${b.matchId}/actions`, reordered)).body.snapshot.version, 1);
  await app.outbox.flush(1000);
  assert.equal(go.events.filter((e) => e.type === 'LAP_COMPLETED').length, 2);
});

test('Outbox network diagnostics are replaced by a public delivery code', async (t) => {
  const go = fakeGo();
  go.beforeEvent = () => { throw new Error('C:\\private\\transport.mjs: secret upstream'); };
  const { request, create } = await appFor(t, { go });
  const m = await create();
  const r = await request(`matches/${m.matchId}`);
  assert.equal(r.body.delivery.pending, 1);
  assert.equal(r.body.delivery.error, 'DELIVERY_FAILED');
  assert.ok(!/private|secret|transport\.mjs/.test(JSON.stringify(r.body)));
});

test('simultaneous duplicates execute once; same-part actions serialize while other matches progress', async (t) => {
  const { app, go, request, create, hooks } = await appFor(t);
  const a = await create(), b = await create(), g = gate();
  hooks.set(a.matchId, () => g.block());
  t.after(g.release);
  const route = `matches/${a.matchId}`;
  const input = action('wait', { type: 'WAIT_LAP' });
  const first = request(route + '/actions', input);
  await g.ready;
  const duplicate = request(route + '/actions', input);
  const next = request(route + '/actions', action('next'));
  assert.equal((await request(`matches/${b.matchId}/actions`, action('wait'))).body.snapshot.version, 1);
  g.release();
  assert.deepEqual((await first).body, (await duplicate).body);
  assert.equal((await next).body.snapshot.version, 2);
  await app.outbox.flush(1000);
  assert.equal(go.events.filter((e) => e.matchId === a.matchId && e.type === 'LAP_COMPLETED').length, 2);
  assert.equal(go.events.filter((e) => e.matchId === b.matchId && e.type === 'LAP_COMPLETED').length, 1);
});

test('partial dependency failure is HTTP 200 with committed snapshot and replay does not repeat events', async (t) => {
  const { app, go, request, create } = await appFor(t);
  const m = await create(), route = `matches/${m.matchId}/actions`;
  const input = action('partial', { type: 'FAIL_AFTER_LAP' });
  const result = await request(route, input);
  assert.equal(result.status, 200);
  assert.equal(result.body.outcome, 'dependency_failed'); assert.equal(result.body.committed, true);
  assert.equal(result.body.snapshot.version, 1); assert.equal(result.body.snapshot.data.laps, 1);
  assert.ok(!/private|confidential|stack|dependency\.mjs/.test(JSON.stringify(result.body)));
  assert.deepEqual((await request(route, input)).body, result.body);
  await app.outbox.flush(1000);
  assert.equal(go.events.filter((e) => e.type === 'LAP_COMPLETED').length, 1);
});

test('finish requested in dispatch completes without deadlock and blocks new actions', async (t) => {
  const { app, go, request, create } = await appFor(t);
  const m = await create(), route = `matches/${m.matchId}`;
  const result = await request(route + '/actions', action('close', { type: 'CLOSE' }));
  assert.equal(result.body.snapshot.state, 'finished');
  assert.equal((await request(route + '/actions', action('late'))).status, 409);
  await app.outbox.flush(1000);
  assert.deepEqual(go.events.map((e) => e.type), ['MATCH_STARTED', 'LAP_COMPLETED', 'MATCH_FINISHED']);
});

test('snapshot and finish queue behind dispatch; prepared/closing cannot execute new actions', async (t) => {
  const { app, request, create, hooks } = await appFor(t);
  const p = await app.sdk.manager.create('racing');
  assert.equal((await request(`matches/${p.matchId}`)).status, 404);
  assert.equal((await request(`matches/${p.matchId}/actions`, action())).status, 409);
  await app.sdk.manager.discard(p.matchId);
  const m = await create(), route = `matches/${m.matchId}`, g = gate();
  hooks.set(m.matchId, () => g.block()); t.after(g.release);
  const running = request(route + '/actions', action('wait', { type: 'WAIT_LAP' }));
  await g.ready;
  const snapshot = request(route);
  const finish = request(route + '/finish', {});
  g.release();
  assert.equal((await running).body.snapshot.version, 1);
  assert.ok((await snapshot).body.version >= 1);
  assert.equal((await finish).body.state, 'finished');
  const other = await create();
  app.outbox.stop();
  assert.equal((await request(`matches/${other.matchId}/finish`, {})).status, 503);
  assert.equal((await request(`matches/${other.matchId}`)).body.state, 'closing');
  assert.equal((await request(`matches/${other.matchId}/actions`, action())).status, 409);
});

test('local acceptance advances SDK without remote delivery; results 202 then real-shaped Go metrics', async (t) => {
  const go = fakeGo(), g = gate(); go.beforeEvent = () => g.block(); t.after(g.release);
  const { app, request, create } = await appFor(t, { go });
  const m = await create(), route = `matches/${m.matchId}`;
  await g.ready;
  assert.equal(m.delivery.pending, 1);
  assert.equal((await request(route + '/actions', action())).body.snapshot.version, 1);
  const pending = await request(route + '/results');
  assert.equal(pending.status, 202); assert.equal(pending.body.code, 'DELIVERY_PENDING');
  assert.equal(go.queries.length, 0);
  go.beforeEvent = null; g.release(); await app.outbox.flush(1000);
  const open = await request(route + '/results');
  assert.equal(open.status, 200); assert.equal(open.body.state, 'open');
  assert.equal(open.body.metrics[0].value, 1); assert.equal(open.body.metrics[0].basis.eventCount, 2);
  await request(route + '/finish', {}); await app.outbox.flush(1000);
  const closed = await request(route + '/results');
  assert.equal(closed.body.state, 'closed'); assert.equal(closed.body.metrics[0].status, 'final');
  assert.equal((await request(route)).body.delivery.delivered, 3);
  assert.deepEqual(go.queries, Array(2).fill(`/results/racing/${m.matchId}`));
});

test('analytics prefix changed during query returns 202 instead of obsolete metrics', async (t) => {
  const { app, go, request, create } = await appFor(t);
  const m = await create(), route = `matches/${m.matchId}`, g = gate(); t.after(g.release);
  await app.outbox.flush(1000); go.beforeResults = () => g.block();
  const results = request(route + '/results'); await g.ready;
  await request(route + '/actions', action()); await app.outbox.flush(1000);
  g.release();
  const changed = await results;
  assert.equal(changed.status, 202); assert.equal(changed.body.code, 'RESULTS_CHANGED');
  assert.equal(changed.body.snapshot.version, 1); assert.ok(!changed.body.metrics);
});

test('Go failures, malformed results and plugin errors remain sanitized; no empty metrics fallback', async (t) => {
  const { app, go, request, create } = await appFor(t);
  const m = await create(), route = `matches/${m.matchId}`;
  await app.outbox.flush(1000);
  for (const [status, expected] of [[404, 404], [409, 502], [500, 502], [503, 503], [504, 504]]) {
    go.resultStatus = status;
    const r = await request(route + '/results'); assert.equal(r.status, expected);
    assert.ok(!r.body.metrics); assert.ok(!/private|trace/.test(JSON.stringify(r.body)));
  }
  go.resultStatus = 200; go.malformed = true;
  assert.equal((await request(route + '/results')).status, 502);
  go.beforeResults = () => { throw new Error('private network details'); };
  assert.equal((await request(route + '/results')).status, 503);
  const failed = await request(route + '/actions', action('throw', { type: 'THROW' }));
  assert.equal(failed.status, 200); assert.equal(failed.body.committed, false);
  assert.ok(!/private|confidential|stack/.test(JSON.stringify(failed.body)));
});

test('methods, Origin, JSON contract and byte budget; headers remain no-store and secure', async (t) => {
  const { request, create } = await appFor(t);
  const m = await create(), route = `matches/${m.matchId}`;
  assert.equal((await request('catalog', {})).status, 405);
  assert.equal((await request(route + '/actions')).status, 405);
  assert.equal((await request('catalog', undefined, { headers: { Origin: 'http://evil.test' } })).status, 403);
  assert.equal((await request('catalog', undefined, { headers: { Origin: 'not a URL' } })).status, 403);
  assert.equal((await request('matches', undefined, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  for (const input of [null, [], action('', {}), action('x', { payload: [] }), action('x', { extra: true }), action('x', { expectedVersion: -1 })]) {
    assert.equal((await request(route + '/actions', input)).status, 400);
  }
  const large = JSON.stringify({ gameId: 'racing', padding: 'é'.repeat(9000) });
  assert.ok(large.length < 16384 && Buffer.byteLength(large) > 16384);
  assert.equal((await request('matches', undefined, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: large })).status, 413);
  assert.equal((await request(route + '/finish', { reason: '\n' })).status, 400);
  assert.equal((await request('matches/missing')).status, 404);
  const r = await request('catalog');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(r.headers.get('content-security-policy'));
});

test('bounded HTTP admission rejects overload without a second queue or cancelling active actions', async (t) => {
  const { request, create, hooks } = await appFor(t, { sdkHTTP: { maxPending: 1 } });
  const m = await create(), g = gate(); t.after(g.release);
  hooks.set(m.matchId, () => g.block());
  const active = request(`matches/${m.matchId}/actions`, action('wait', { type: 'WAIT_LAP' }));
  await g.ready;
  const busy = await request('catalog');
  assert.equal(busy.status, 429); assert.equal(busy.body.error.code, 'HTTP_ADMISSION_LIMIT');
  g.release(); assert.equal((await active).body.snapshot.version, 1);
  assert.equal((await request('catalog')).status, 200);
});

test('dispatch queues with activation and an HTTP disconnect does not undo a confirmed action', async (t) => {
  const { app, request, hooks, base } = await appFor(t);
  const p = await app.sdk.manager.create('racing');
  const activation = app.sdk.manager.activate(p.matchId);
  const route = `matches/${p.matchId}`;
  assert.equal((await request(route + '/actions', action('after-activation'))).body.snapshot.version, 1);
  assert.equal((await activation).state, 'running');
  const g = gate(); t.after(g.release); hooks.set(p.matchId, () => g.block());
  const controller = new AbortController();
  const input = action('disconnected', { type: 'WAIT_LAP' });
  const disconnected = fetch(base + '/api/sdk/' + route + '/actions', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
  const rejection = assert.rejects(disconnected, { name: 'AbortError' });
  await g.ready; controller.abort(); await rejection; g.release();
  const replay = await request(route + '/actions', input);
  assert.equal(replay.body.outcome, 'completed'); assert.equal(replay.body.snapshot.version, 2);
  assert.equal((await request(route)).body.data.laps, 2);
});

test('analytics timeout and malformed JSON have distinct safe infrastructure errors', async (t) => {
  const go = fakeGo();
  const { app, request, create } = await appFor(t, { go, sdkHTTP: { resultsTimeoutMs: 20 } });
  const m = await create(); await app.outbox.flush(1000);
  go.beforeResults = (signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  assert.equal((await request(`matches/${m.matchId}/results`)).status, 504);
  go.beforeResults = null;
  go.rawResults = '{private-invalid-json';
  assert.equal((await request(`matches/${m.matchId}/results`)).status, 502);
});
