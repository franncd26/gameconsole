import test from 'node:test';
import assert from 'node:assert/strict';
import { GameInstanceManager } from '../server/sdk/instance-manager.mjs';
import { SnakeRules } from '../plugins/snake/server/snake-rules.mjs';
import { packageHarness, verifyPackage } from './helpers/sdk-package.mjs';

const entrypoint = `
import original from './original-index.mjs';
import { SnakeSession } from './snake-session.mjs';
import { SnakeRules } from './snake-rules.mjs';
export const control = { initial:null, randomFactory:() => () => 0 };
class FixtureRules extends SnakeRules { initial(size) { return control.initial ? structuredClone(control.initial) : super.initial(size); } }
export default {...original, createSession(context, options) {
  return {startData:{gridSize:options.size}, session:new SnakeSession(context, options,
    {rules:new FixtureRules(), random:control.randomFactory()})};
}};`;
const setup = (t) => packageHarness(t, 'snake', { entrypoint });
const rules = new SnakeRules();
const seed = (body, direction = 'right') => ({ size: 12, body, direction, food: null, points: 0, result: null });
function appleAhead() {
  const data = rules.initial(12), cells = rules.freeCells(12, data.body);
  return (cells.findIndex((p) => p.x === 4 && p.y === 6) + 0.5) / cells.length;
}

test('Snake authentic package manifest, initialization, options/participants and audited profile', async (t) => {
  const h = await packageHarness(t, 'snake');
  const manifest = h.registry.get('snake').manifest;
  assert.equal(manifest.version, '1.1.0'); assert.equal(manifest.capabilities.multipleInstances, true);
  for (const size of [12, 20, 28]) {
    const s = await h.start({ size });
    assert.equal(s.data.size, size); assert.equal(s.data.body.length, 3); assert.equal(s.data.direction, 'right');
    assert.equal(s.data.points, 0); assert.equal(s.data.result, null);
    assert.ok(!s.data.body.some((p) => p.x === s.data.food.x && p.y === s.data.food.y));
    assert.deepEqual(h.events.at(-1).data, { gridSize: size, players: ['human'] });
    await h.manager.finish(s.matchId);
  }
  const defaultMatch = await h.start(); assert.equal(defaultMatch.data.size, 20); await h.manager.finish(defaultMatch.matchId);
  for (const size of [13, 0, '20', null]) await assert.rejects(h.manager.create('snake', { options: { size } }), { code: 'INVALID_OPTIONS' });
  for (const players of [[], [{ id: 'p1', role: 'human' }], [{ id: 'human', role: 'ai' }]]) {
    await assert.rejects(h.manager.create('snake', { players }), { code: 'INVALID_PLAYERS' });
  }
  await verifyPackage('snake', '04c242dacea70a1c84e91240f04dc69d56764cc9');
});

test('normal TICK confirms without event; opposite direction ignored; exact payload rejects without changes', async (t) => {
  const h = await setup(t), s = await h.start({ size: 12 });
  for (const payload of [{}, { direction: 'up', extra: 1 }, { direction: 'invalid' }, { direction: 1 }]) {
    const r = await h.dispatch(s.matchId, 'TICK', payload);
    assert.equal(r.outcome, 'rejected'); assert.equal(r.committed, false); assert.equal(r.snapshot.version, 0);
  }
  assert.equal((await h.dispatch(s.matchId, 'UNKNOWN', { direction: 'right' })).outcome, 'rejected');
  const r = await h.dispatch(s.matchId, 'TICK', { direction: 'left' });
  assert.equal(r.snapshot.data.direction, 'right'); assert.deepEqual(r.snapshot.data.body[0], { x: 4, y: 6 });
  assert.equal(r.confirmations, 1); assert.equal(r.snapshot.version, 1); assert.equal(h.events.length, 1);
});

test('apple confirms +10, growth, free-only relocation; replay/version conflict do not consume randomness', async (t) => {
  const h = await setup(t); let calls = 0;
  h.control.randomFactory = () => () => { calls++; return calls === 1 ? appleAhead() : 0; };
  const s = await h.start({ size: 12 });
  const input = { requestId: 'apple', type: 'TICK', payload: { direction: 'right' }, expectedVersion: 0 };
  const r = await h.manager.dispatch(s.matchId, input);
  assert.equal(r.snapshot.data.points, 10); assert.equal(r.snapshot.data.body.length, 4); assert.equal(calls, 2);
  assert.ok(!r.snapshot.data.body.some((p) => p.x === r.snapshot.data.food.x && p.y === r.snapshot.data.food.y));
  assert.deepEqual(h.events.at(-1).data, { points: 10 }); assert.equal(h.events.at(-1).playerId, 'human');
  await h.dispatch(s.matchId, 'TICK', { direction: 'right' });
  assert.deepEqual(await h.manager.dispatch(s.matchId, input), r);
  assert.equal((await h.dispatch(s.matchId, 'TICK', { direction: 'right' }, { expectedVersion: 0 })).error.code, 'VERSION_CONFLICT');
  assert.equal(calls, 2); assert.equal(h.events.filter((e) => e.type === 'APPLE_EATEN').length, 1);
});

test('wall death confirms terminal state, PLAYER_DIED, then one host close', async (t) => {
  const h = await setup(t); let s = await h.start({ size: 12 });
  for (let i = 0; i < 12 && s.state === 'running'; i++) s = (await h.dispatch(s.matchId, 'TICK', { direction: 'right' })).snapshot;
  assert.equal(s.data.result, 'game_over'); assert.equal(s.state, 'finished'); assert.equal(s.data.body[0].x, 11);
  assert.deepEqual(h.events.map((e) => e.type), ['MATCH_STARTED', 'PLAYER_DIED', 'MATCH_FINISHED']);
  assert.deepEqual(h.events[1].data, { cause: 'wall' });
  await h.manager.finish(s.matchId); assert.equal(h.events.length, 3);
  assert.equal((await h.dispatch(s.matchId, 'TICK', { direction: 'up' })).error.code, 'INVALID_LIFECYCLE');
});

test('body collision excludes moving tail; actual session handles both cases without mutating old snapshots', async (t) => {
  const h = await setup(t);
  const shape = [{ x: 2, y: 2 }, { x: 1, y: 2 }, { x: 1, y: 3 }, { x: 2, y: 3 }];
  h.control.initial = seed(shape);
  const tail = await h.start({ size: 12 });
  const moved = await h.dispatch(tail.matchId, 'TICK', { direction: 'down' });
  assert.equal(moved.snapshot.state, 'running'); assert.deepEqual(moved.snapshot.data.body[0], { x: 2, y: 3 });
  assert.deepEqual(tail.data.body, shape); assert.equal(h.events.length, 1);
  await h.manager.finish(tail.matchId);
  h.control.initial = seed([...shape, { x: 3, y: 3 }]);
  const body = await h.start({ size: 12 });
  const dead = await h.dispatch(body.matchId, 'TICK', { direction: 'down' });
  assert.equal(dead.snapshot.data.result, 'game_over'); assert.equal(h.events.at(-2).data.cause, 'self_collision');
});

test('last apple fills board, closes once with board_completed and no PLAYER_DIED', async (t) => {
  const h = await setup(t), path = [];
  for (let y = 0; y < 12; y++) for (let n = 0; n < 12; n++) path.push({ x: y % 2 ? 11 - n : n, y });
  h.control.initial = { ...seed(path.slice(0, -1).reverse(), 'left'), points: 1400 };
  const s = await h.start({ size: 12 });
  const r = await h.dispatch(s.matchId, 'TICK', { direction: 'left' });
  assert.equal(r.snapshot.data.body.length, 144); assert.equal(r.snapshot.data.food, null);
  assert.equal(r.snapshot.data.result, 'board_completed'); assert.equal(r.snapshot.state, 'finished');
  assert.equal(r.snapshot.data.points, 1410); assert.deepEqual(h.events[1].data, { points: 10 });
  assert.deepEqual(h.events.map((e) => e.type), ['MATCH_STARTED', 'APPLE_EATEN', 'MATCH_FINISHED']);
});

test('local acceptance rejection preserves body/food/points, failed replay and retry follow manager semantics', async (t) => {
  const h = await setup(t); let calls = 0;
  h.control.randomFactory = () => () => ++calls === 1 ? appleAhead() : 0;
  const s = await h.start({ size: 12 });
  h.sink.before = async () => { throw new Error('sink failure'); };
  const input = { requestId: 'failed', type: 'TICK', payload: { direction: 'right' } };
  const failed = await h.manager.dispatch(s.matchId, input);
  assert.equal(failed.error.code, 'EVENT_ACCEPTANCE_FAILED'); assert.equal(failed.committed, false);
  assert.deepEqual(failed.snapshot.data, s.data); assert.equal(failed.snapshot.version, 0);
  const consumed = calls;
  assert.deepEqual(await h.manager.dispatch(s.matchId, input), failed); assert.equal(calls, consumed);
  h.sink.before = async () => {};
  assert.equal((await h.dispatch(s.matchId, 'TICK', { direction: 'right' })).snapshot.data.points, 10);
});

test('random dependencies are owned per session; another manager/session does not share its sequence', async (t) => {
  const h = await setup(t); const counters = [];
  h.control.randomFactory = () => { const i = counters.length; counters.push(0); return () => { counters[i]++; return i ? 1 : appleAhead(); }; };
  const first = await h.start({ size: 12 });
  const secondManager = new GameInstanceManager(h.factory, { eventSink: h.sink });
  const prepared = await secondManager.create('snake', { options: { size: 12 } });
  const second = await secondManager.activate(prepared.matchId);
  assert.notDeepEqual(first.data.food, second.data.food); assert.deepEqual(counters, [1, 1]);
  await h.dispatch(first.matchId, 'TICK', { direction: 'right' });
  assert.deepEqual(counters, [2, 1]); assert.deepEqual((await secondManager.getSnapshot(second.matchId)).data, second.data);
});
