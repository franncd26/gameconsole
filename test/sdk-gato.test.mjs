import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, copyFile, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverPlugins } from '../server/sdk/registry.mjs';
import { GamePluginLoader } from '../server/sdk/loader.mjs';
import { GameSessionFactory } from '../server/sdk/session-factory.mjs';
import { GameInstanceManager } from '../server/sdk/instance-manager.mjs';
import { prepareSDK } from '../server/sdk/bootstrap.mjs';
import { createApp } from '../server/index.mjs';
import { PrologAdapter, PrologFailure } from '../plugins/tic-tac-toe/server/prolog-adapter.mjs';

const original = new URL('../plugins/tic-tac-toe/', import.meta.url);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Only the adapter in a temporary package copy changes. Entrypoint/session/rules remain authentic.
const fakeAdapter = `
import { PrologAdapter as RealAdapter } from './real-prolog-adapter.mjs';
export { PrologFailure } from './real-prolog-adapter.mjs';
export const control = {
  calls: [],
  handler: (board, {difficulty}) => ({index: [4,0,2,6,8,1,3,5,7].find(i => board[i] === ''),
    algorithm: {easy:'reglas_basicas',medium:'reglas_tacticas',hard:'minimax'}[difficulty], score: difficulty === 'hard' ? 0 : null}),
};
export class PrologAdapter extends RealAdapter {
  constructor() { super({ request: (board, options) => {
    control.calls.push({board:[...board], difficulty:options.difficulty});
    return control.handler(board, options);
  } }); }
}`;
async function installation(t, { mockAI = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sdk-gato-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'relocated-gato');
  await cp(original, dir, { recursive: true });
  let control;
  if (mockAI) {
    await copyFile(path.join(dir, 'server/prolog-adapter.mjs'), path.join(dir, 'server/real-prolog-adapter.mjs'));
    await writeFile(path.join(dir, 'server/prolog-adapter.mjs'), fakeAdapter);
    control = (await import(pathToFileURL(await realpath(path.join(dir, 'server/prolog-adapter.mjs'))).href)).control;
  }
  assert.equal(await readFile(path.join(dir, 'server/index.mjs'), 'utf8'), await readFile(new URL('server/index.mjs', original), 'utf8'));
  return { root, dir, control };
}
async function setup(t, config) {
  const installed = await installation(t);
  const { registry, errors } = await discoverPlugins(installed.root);
  assert.deepEqual(errors, []);
  const loader = new GamePluginLoader(registry, { trustedIds: ['tic-tac-toe'] });
  const events = [], batches = [];
  const sink = { before: async () => {},
    async accept(event) { await this.before([event]); events.push(structuredClone(event)); },
    async acceptBatch(batch) { await this.before(batch); batches.push(structuredClone(batch)); events.push(...structuredClone(batch)); },
  };
  const manager = new GameInstanceManager(new GameSessionFactory(loader), { eventSink: sink });
  const prepared = await manager.create('tic-tac-toe', config);
  assert.equal(installed.control.calls.length, 0);
  const match = await manager.activate(prepared.matchId);
  let sequence = 0;
  const dispatch = (type, payload = {}, extra = {}) => manager.dispatch(match.matchId, { requestId: `action-${++sequence}`, type, payload, ...extra });
  return { ...installed, registry, loader, manager, match, events, batches, sink, dispatch };
}

test('authentic relocated package discovers/bootstraps/initializes with no Prolog invocation during preparation', async (t) => {
  const { root } = await installation(t, { mockAI: false });
  const { registry, errors } = await discoverPlugins(root);
  assert.deepEqual(errors, []);
  const m = registry.get('tic-tac-toe').manifest;
  assert.equal(m.version, '1.1.0'); assert.equal(m.capabilities.multipleInstances, false);
  const app = createApp({ sdk: await prepareSDK({ pluginsDirectory: root, trustedIds: ['tic-tac-toe'] }),
    statsURL: 'http://go.test', statsFetcher: async () => new Response('{}', { status: 201 }) });
  t.after(() => app.outbox.stop());
  const prepared = await app.sdk.manager.create('tic-tac-toe');
  assert.equal(prepared.state, 'prepared'); assert.equal(app.outbox.status(prepared.matchId).pending, 0);
  assert.deepEqual(prepared.data, { board: Array(9).fill(''), turn: 0, difficulty: 'hard', winningLine: [],
    lastDecision: null, result: null, awaitingAI: false });
  assert.equal((await app.sdk.manager.activate(prepared.matchId)).state, 'running');
});

test('defaults, three difficulties, participants and MATCH_STARTED use the existing declarative contracts', async (t) => {
  const { manager, match, control, events } = await setup(t);
  assert.equal(match.options.difficulty, 'hard');
  for (const difficulty of ['easy', 'medium', 'hard']) {
    await manager.finish((await manager.list()).at(-1).matchId);
    const prepared = await manager.create('tic-tac-toe', { options: { difficulty },
      players: [{ id: 'human', role: 'human' }, { id: 'prolog', role: 'ai' }] });
    const active = await manager.activate(prepared.matchId);
    assert.equal(active.data.difficulty, difficulty);
    assert.deepEqual(events.at(-1).data, { players: ['human', 'prolog'], symbols: { human: 'X', prolog: 'O' }, difficulty });
  }
  await manager.finish((await manager.list()).at(-1).matchId);
  for (const config of [{ options: { difficulty: 'invalid' } }, { options: { extra: true } }, { players: [] },
    { players: [{ id: 'human', role: 'human' }] }, { players: [{ id: 'human', role: 'human' }, { id: 'prolog', role: 'human' }] }]) {
    await assert.rejects(manager.create('tic-tac-toe', config));
  }
  assert.equal(control.calls.length, 0);
});

test('legal PLACE_MARK confirms human before AI, then one two-event batch and two public versions', async (t) => {
  const { dispatch, match, events, batches, control } = await setup(t);
  control.handler = (board) => {
    assert.equal(events.length, 2, 'human MOVE_PLACED must be locally accepted before requesting AI');
    assert.equal(board[0], 'X'); assert.ok(Object.isFrozen(board));
    return { index: 4, algorithm: 'minimax', score: 0 };
  };
  const result = await dispatch('PLACE_MARK', { index: 0 }, { expectedVersion: 0 });
  assert.equal(result.outcome, 'completed'); assert.equal(result.committed, true); assert.equal(result.confirmations, 2);
  assert.equal(result.snapshot.version, 2); assert.equal(result.snapshot.data.turn, 2);
  assert.deepEqual(result.snapshot.data.board, ['X', '', '', '', 'O', '', '', '', '']);
  assert.equal(result.snapshot.data.awaitingAI, false);
  assert.deepEqual(events.map((e) => e.type), ['MATCH_STARTED', 'MOVE_PLACED', 'AI_DECISION', 'MOVE_PLACED']);
  assert.deepEqual(events[1].data, { turn: 1, row: 0, column: 0, symbol: 'X' });
  assert.equal(batches.length, 1); assert.equal(batches[0].length, 2);
  assert.deepEqual(events[2].data, { index: 4, score: 0, algorithm: 'minimax', difficulty: 'hard', board: ['X', '', '', '', '', '', '', '', ''] });
  assert.deepEqual(events[3].data, { turn: 2, row: 1, column: 1, symbol: 'O' });
  for (const e of events) {
    assert.equal(e.schemaVersion, 1); assert.equal(e.gameId, 'tic-tac-toe'); assert.equal(e.gameVersion, '1.1.0');
    assert.equal(e.matchId, match.matchId); assert.match(e.eventId, UUID); assert.ok(Number.isFinite(Date.parse(e.timestamp)));
  }
  assert.deepEqual(events.map((e) => e.playerId), [undefined, 'human', 'prolog', 'prolog']);
});

test('invalid index/occupied cell/unknown action/exact payload/illegal RETRY_AI reject without events or versions', async (t) => {
  const { dispatch, events, manager, match } = await setup(t);
  for (const index of [-1, 9, 0.5, '0', null]) {
    const r = await dispatch('PLACE_MARK', { index });
    assert.equal(r.outcome, 'rejected'); assert.equal(r.committed, false); assert.equal(r.confirmations, 0);
  }
  for (const [type, payload] of [['PLACE_MARK', {}], ['PLACE_MARK', { index: 0, extra: 1 }], ['RETRY_AI', {}], ['UNKNOWN', {}]]) {
    assert.equal((await dispatch(type, payload)).outcome, 'rejected');
  }
  assert.equal(events.length, 1); assert.equal((await manager.getSnapshot(match.matchId)).version, 0);
  await dispatch('PLACE_MARK', { index: 0 });
  for (const index of [0, 4]) assert.equal((await dispatch('PLACE_MARK', { index })).outcome, 'rejected');
  assert.equal(events.length, 4); assert.equal((await manager.getSnapshot(match.matchId)).version, 2);
});

test('Prolog failure preserves X, rejects wrong turn, replays original request, then RETRY_AI recovers O', async (t) => {
  const { dispatch, control, manager, match, events } = await setup(t);
  control.handler = () => { throw new Error('C:/private/swipl: secret timeout'); };
  const input = { requestId: 'human-move', type: 'PLACE_MARK', payload: { index: 0 }, expectedVersion: 0 };
  const failed = await manager.dispatch(match.matchId, input);
  assert.equal(failed.outcome, 'dependency_failed'); assert.equal(failed.committed, true); assert.equal(failed.confirmations, 1);
  assert.equal(failed.snapshot.version, 1); assert.equal(failed.snapshot.state, 'running');
  assert.equal(failed.snapshot.data.board[0], 'X'); assert.equal(failed.snapshot.data.awaitingAI, true);
  assert.equal((await dispatch('PLACE_MARK', { index: 1 })).outcome, 'rejected');
  assert.equal((await dispatch('RETRY_AI', { extra: 1 })).outcome, 'rejected');
  const retryFailure = await dispatch('RETRY_AI');
  assert.equal(retryFailure.outcome, 'dependency_failed'); assert.equal(retryFailure.committed, false);
  assert.equal(retryFailure.snapshot.version, 1); assert.equal(events.length, 2);
  assert.ok(!/secret|private|swipl/.test(JSON.stringify(failed)));
  assert.deepEqual(await manager.dispatch(match.matchId, input), failed);
  const calls = control.calls.length;
  control.handler = () => ({ index: 4, score: 0, algorithm: 'minimax' });
  const recovered = await dispatch('RETRY_AI');
  assert.equal(recovered.outcome, 'completed'); assert.equal(recovered.confirmations, 1);
  assert.equal(recovered.snapshot.version, 2); assert.equal(recovered.snapshot.data.board[4], 'O');
  assert.equal(recovered.snapshot.data.awaitingAI, false); assert.equal(control.calls.length, calls + 1);
  assert.deepEqual(await manager.dispatch(match.matchId, input), failed, 'replay retains the original pending snapshot');
  assert.deepEqual(events.map((e) => e.type), ['MATCH_STARTED', 'MOVE_PLACED', 'AI_DECISION', 'MOVE_PLACED']);
});

test('invalid AI data/index/score/algorithm never confirms AI state or events', async (t) => {
  const { manager, control, match, events } = await setup(t);
  let current = match;
  for (const bad of [null, 'invalid JSON response', {}, { index: -1, score: 0, algorithm: 'minimax' },
    { index: 0, score: 0, algorithm: 'minimax' }, { index: 4, score: 99, algorithm: 'minimax' },
    { index: 4, score: null, algorithm: 'minimax' }, { index: 4, score: 0, algorithm: 'shell' },
    { index: 4, score: 0, algorithm: 'minimax', extra: true }]) {
    control.handler = () => bad;
    const r = await manager.dispatch(current.matchId, { requestId: 'invalid-ai', type: 'PLACE_MARK', payload: { index: 0 } });
    assert.equal(r.outcome, 'dependency_failed'); assert.equal(r.snapshot.version, 1); assert.equal(r.snapshot.data.awaitingAI, true);
    assert.equal(events.filter((e) => e.matchId === current.matchId).length, 2);
    assert.equal(r.snapshot.data.lastDecision, null);
    await manager.finish(current.matchId);
    const p = await manager.create('tic-tac-toe'); current = await manager.activate(p.matchId);
  }
});

test('coordinator sink rejection keeps versions coherent and is not mislabeled as a Prolog decision', async (t) => {
  const { dispatch, sink, events, control } = await setup(t);
  sink.before = async (batch) => { if (batch.length === 2) throw new Error('sink unavailable'); };
  const r = await dispatch('PLACE_MARK', { index: 0 });
  assert.equal(r.error.code, 'EVENT_ACCEPTANCE_FAILED'); assert.equal(r.committed, true);
  assert.equal(r.snapshot.version, 1); assert.equal(r.snapshot.data.board[4], '');
  assert.equal(r.snapshot.data.awaitingAI, true); assert.equal(events.length, 2); assert.equal(control.calls.length, 1);
  sink.before = async () => {};
  assert.equal((await dispatch('RETRY_AI')).snapshot.version, 2);
});

test('a rejected human confirmation never invokes AI or publishes a changed board', async (t) => {
  const { dispatch, sink, events, control } = await setup(t);
  sink.before = async () => { throw new Error('local acceptance unavailable'); };
  const result = await dispatch('PLACE_MARK', { index: 0 });
  assert.equal(result.outcome, 'rejected'); assert.equal(result.committed, false);
  assert.equal(result.error.code, 'EVENT_ACCEPTANCE_FAILED'); assert.equal(result.snapshot.version, 0);
  assert.deepEqual(result.snapshot.data.board, Array(9).fill('')); assert.equal(control.calls.length, 0);
  assert.equal(events.length, 1);
});

test('each difficulty reaches the real session adapter with the matching algorithm and score contract', async (t) => {
  for (const [difficulty, algorithm] of [['easy', 'reglas_basicas'], ['medium', 'reglas_tacticas'], ['hard', 'minimax']]) {
    const { dispatch, control } = await setup(t, { options: { difficulty } });
    const result = await dispatch('PLACE_MARK', { index: 0 });
    assert.equal(result.outcome, 'completed');
    assert.equal(control.calls[0].difficulty, difficulty);
    assert.deepEqual(result.snapshot.data.lastDecision, { index: 4, algorithm, score: difficulty === 'hard' ? 0 : null });
  }
});

for (const scenario of [
  { name: 'human victory', human: [4, 2, 6], ai: [0, 1], result: 'human_won', line: [2, 4, 6] },
  { name: 'AI victory', human: [0, 1, 8], ai: [3, 4, 5], result: 'prolog_won', line: [3, 4, 5] },
  { name: 'draw', human: [0, 2, 3, 7, 8], ai: [1, 4, 6, 5], result: 'draw', line: [] },
]) test(`${scenario.name}: actual plugin rules complete once, preserve result, and reject new actions`, async (t) => {
  const { dispatch, control, events, manager, match } = await setup(t, { options: { difficulty: 'easy' } });
  const ai = [...scenario.ai];
  control.handler = () => ({ index: ai.shift(), algorithm: 'reglas_basicas', score: null });
  let result;
  for (const index of scenario.human) result = await dispatch('PLACE_MARK', { index });
  const s = result.snapshot;
  assert.equal(result.outcome, 'completed'); assert.equal(s.state, 'finished'); assert.equal(s.data.result, scenario.result);
  assert.deepEqual(s.data.winningLine, scenario.line); assert.equal(s.data.awaitingAI, false);
  assert.equal(s.data.turn, scenario.human.length + scenario.ai.length);
  assert.equal(s.version, s.data.turn + 1, 'one version per move plus host close');
  assert.equal(s.data.lastDecision.index, scenario.ai.at(-1)); assert.equal(ai.length, 0);
  assert.equal(events.at(-1).type, 'MATCH_FINISHED'); assert.equal(events.at(-1).data.reason, 'completed');
  assert.equal((await dispatch('PLACE_MARK', { index: 0 })).error.code, 'INVALID_LIFECYCLE');
  await manager.finish(match.matchId);
  assert.equal(events.filter((e) => e.type === 'MATCH_FINISHED').length, 1);
});

test('single-active-instance manifest policy and administrative abandonment preserve domain data', async (t) => {
  const { manager, match, dispatch, events } = await setup(t);
  await assert.rejects(manager.create('tic-tac-toe'), { code: 'MULTIPLE_INSTANCES_DISABLED' });
  await dispatch('PLACE_MARK', { index: 0 });
  const before = await manager.getSnapshot(match.matchId);
  const abandoned = await manager.finish(match.matchId, { reason: 'abandoned' });
  assert.equal(abandoned.state, 'finished'); assert.deepEqual(abandoned.data, before.data);
  assert.equal(abandoned.data.result, null, 'administrative reason is not a fabricated game result');
  assert.equal(events.at(-1).data.reason, 'abandoned');
  const next = await manager.create('tic-tac-toe');
  assert.notEqual(next.matchId, match.matchId); assert.deepEqual(next.data.board, Array(9).fill(''));
});

test('real PrologAdapter boundary accepts three contracts and sanitizes mocked process/timeout failures without spawning', async () => {
  const board = ['X', '', '', '', '', '', '', '', ''];
  for (const [difficulty, algorithm] of [['easy', 'reglas_basicas'], ['medium', 'reglas_tacticas'], ['hard', 'minimax']]) {
    const adapter = new PrologAdapter({ request: async () => ({ index: 4, algorithm, score: difficulty === 'hard' ? 0 : null }) });
    assert.equal((await adapter.decide(board, { difficulty })).algorithm, algorithm);
  }
  for (const message of ['spawn failed: C:/private/swipl', 'timeout', 'malformed JSON']) {
    const adapter = new PrologAdapter({ request: () => { throw new Error(message); } });
    await assert.rejects(adapter.decide(board, { difficulty: 'hard' }), (error) => {
      assert.ok(error instanceof PrologFailure); assert.ok(!error.message.includes(message)); return true;
    });
  }
});

test('package imports remain inside its boundary; Prolog/tests/profile are exact copies of the audited sources', async () => {
  const root = fileURLToPath(original);
  for (const name of await readdir(new URL('server/', original))) {
    const text = await readFile(new URL(`server/${name}`, original), 'utf8');
    const specifiers = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const specifier of specifiers) {
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('./') || specifier.startsWith('../'));
      const target = path.resolve(root, 'server', specifier);
      assert.ok(path.relative(root, target) && !path.relative(root, target).startsWith('..'));
    }
    assert.ok(!/server\/games|server\/prolog|server\/index|randomUUID|import\s*\(/.test(text));
  }
  for (const name of ['gato.pl', 'gato_tests.pl']) {
    assert.deepEqual(await readFile(new URL(`prolog/${name}`, original)), await readFile(new URL(`../prolog/${name}`, import.meta.url)));
  }
  assert.deepEqual(await readFile(new URL('analytics/profile.json', original)),
    await readFile(new URL('../.deps/gamestats/docs/examples/profiles/tic-tac-toe.json', import.meta.url)));
});

test('HTTP creates and plays the relocated authentic Gato package through generic SDK routes with a fake AI', async (t) => {
  const { root, control } = await installation(t);
  const delivered = [];
  const app = createApp({ sdk: await prepareSDK({ pluginsDirectory: root, trustedIds: ['tic-tac-toe'] }),
    statsURL: 'http://go.test', statsFetcher: async (_url, init) => {
      delivered.push(JSON.parse(init.body)); return new Response('{}', { status: 201 });
    } });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { app.outbox.stop(); app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)); });
  const base = `http://127.0.0.1:${app.server.address().port}/api/sdk/`;
  const post = async (route, input) => {
    const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    return { status: r.status, body: await r.json() };
  };
  assert.deepEqual((await (await fetch(base + 'catalog')).json()).map((m) => m.id), ['tic-tac-toe']);
  const created = await post('matches', { gameId: 'tic-tac-toe' });
  assert.equal(created.status, 201); assert.equal(created.body.state, 'running'); assert.equal(control.calls.length, 0);
  const route = `matches/${created.body.matchId}`;
  assert.equal((await post('matches', { gameId: 'tic-tac-toe' })).status, 409);
  const input = { requestId: 'http-x', type: 'PLACE_MARK', payload: { index: 0 }, expectedVersion: 0 };
  const result = await post(route + '/actions', input);
  assert.equal(result.status, 200); assert.equal(result.body.snapshot.version, 2);
  assert.deepEqual((await post(route + '/actions', input)).body, result.body);
  assert.equal((await post(route + '/finish', { reason: 'abandoned' })).body.state, 'finished');
  assert.equal((await post(route + '/actions', { ...input, requestId: 'new-action' })).status, 409);
  await app.outbox.flush(1000);
  assert.deepEqual(delivered.map((e) => e.type), ['MATCH_STARTED', 'MOVE_PLACED', 'AI_DECISION', 'MOVE_PLACED', 'MATCH_FINISHED']);
  assert.deepEqual(delivered[0].data, { symbols: { human: 'X', prolog: 'O' }, difficulty: 'hard', players: ['human', 'prolog'] });
});
