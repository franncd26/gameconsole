import test from 'node:test';
import assert from 'node:assert/strict';
import { Racing } from '../server/games.mjs'; // Static reference only; no historical test suite or Prolog execution.
import { GameInstanceManager } from '../server/sdk/instance-manager.mjs';
import { RacingRules } from '../plugins/racing/server/racing-rules.mjs';
import { packageHarness, verifyPackage } from './helpers/sdk-package.mjs';

const entrypoint = `
import original from './original-index.mjs';
import { RacingSession } from './racing-session.mjs';
import { RacingRules } from './racing-rules.mjs';
export const control = {now:1000, initial:null, clockFactory:() => () => control.now};
class FixtureRules extends RacingRules { initial(now) { return control.initial ? structuredClone(control.initial) : super.initial(now); } }
export default {...original, createSession(context, options) {
  return {startData:{},session:new RacingSession(context, options,{rules:new FixtureRules(),clock:control.clockFactory()})};
}};`;
const setup = (t) => packageHarness(t, 'racing', { entrypoint });
const input = (extra = {}) => ({ lane: 2, accelerate: true, brake: false, ...extra });
const initial = () => new RacingRules().initial(1000);

test('Circuito authentic manifest/init/options/participants and pinned portable profile', async (t) => {
  const h = await packageHarness(t, 'racing'), s = await h.start();
  assert.equal(h.registry.get('racing').manifest.capabilities.multipleInstances, true);
  assert.equal(s.data.lap, 0); assert.equal(s.data.totalLaps, 3); assert.equal(s.data.lapLength, 1200);
  assert.equal(s.data.lane, 1); assert.equal(s.data.speed, 0); assert.equal(s.data.result, null);
  assert.deepEqual(s.data.obstacles, initial().obstacles); assert.deepEqual(s.data.hit, []);
  assert.deepEqual(h.events[0].data, { players: ['human'] });
  assert.ok(Number.isSafeInteger(s.data.lastTick)); assert.equal(s.data.lastTick, s.data.lapStarted);
  await h.manager.finish(s.matchId);
  await assert.rejects(h.manager.create('racing', { options: { totalLaps: 4 } }), { code: 'INVALID_OPTIONS' });
  await assert.rejects(h.manager.create('racing', { players: [] }), { code: 'INVALID_PLAYERS' });
  await verifyPackage('racing', '2d9631f0807c6d2ab437165cf1e41f8485f55b62');
});

test('exact STEP validation precedes reading clock; invalid controls preserve version and state', async (t) => {
  const h = await setup(t); let calls = 0;
  h.control.clockFactory = () => () => { calls++; return 1000; };
  const s = await h.start();
  for (const payload of [{}, { lane: 1 }, input({ lane: -1 }), input({ lane: 3 }), input({ lane: 0.5 }),
    input({ accelerate: 1 }), input({ brake: null }), input({ extra: true })]) {
    const r = await h.dispatch(s.matchId, 'STEP', payload);
    assert.equal(r.outcome, 'rejected'); assert.equal(r.committed, false); assert.deepEqual(r.snapshot.data, s.data);
  }
  assert.equal((await h.dispatch(s.matchId, 'UNKNOWN', input())).outcome, 'rejected');
  assert.equal(calls, 1); assert.equal(h.events.length, 1);
});

test('speed stays precise: acceleration, passive slowdown, braking, lane change, dt cap and max/min speed', async (t) => {
  const h = await setup(t), s = await h.start();
  h.control.now = 1100;
  const a = (await h.dispatch(s.matchId, 'STEP', input())).snapshot;
  assert.equal(a.data.speed, 6.5); assert.equal(a.data.progress, 0.65); assert.equal(a.data.lane, 2);
  h.control.now = 1200;
  const b = (await h.dispatch(s.matchId, 'STEP', input({ lane: 0, accelerate: false }))).snapshot;
  assert.equal(b.data.speed, 4.7); assert.ok(Math.abs(b.data.progress - 1.12) < 1e-12); assert.equal(b.data.lane, 0);
  h.control.now = 1300;
  assert.equal((await h.dispatch(s.matchId, 'STEP', input({ accelerate: false, brake: true }))).snapshot.data.speed, 0);
  h.control.now = 100000;
  const capped = (await h.dispatch(s.matchId, 'STEP', input())).snapshot;
  assert.equal(capped.data.speed, 16.25); // One capped .25s step despite a long wall-clock interval.
  for (let i = 0; i < 12; i++) { h.control.now += 250; await h.dispatch(s.matchId, 'STEP', input({ lane: 0 })); }
  assert.equal((await h.manager.getSnapshot(s.matchId)).data.speed, 180);
});

test('obstacle impacts once per lap; penalty applies after advancement and changes no previous snapshot', async (t) => {
  const h = await setup(t); h.control.initial = { ...initial(), speed: 180, progress: 230 };
  const s = await h.start(); h.control.now = 1250;
  const r = await h.dispatch(s.matchId, 'STEP', input({ lane: 1 }));
  assert.equal(r.snapshot.data.progress, 275); assert.equal(r.snapshot.data.speed, 54);
  assert.equal(r.snapshot.data.collisions, 1); assert.deepEqual(r.snapshot.data.hit, [0]);
  assert.deepEqual(h.events[1].data, { lap: 1, lane: 1 }); assert.equal(h.events[1].type, 'OBSTACLE_HIT');
  assert.equal(s.data.progress, 230); assert.deepEqual(s.data.hit, []);
  h.control.now = 1500; await h.dispatch(s.matchId, 'STEP', input({ lane: 1 }));
  assert.equal(h.events.filter((e) => e.type === 'OBSTACLE_HIT').length, 1);
});

test('same-step impact and lap retain historical event order in one batch, positive time, remainder and cleared hits', async (t) => {
  const h = await setup(t);
  h.control.initial = { ...initial(), progress: 1180, speed: 180, obstacles: [{ position: 1190, lane: 2 }] };
  const s = await h.start(); h.control.now = 1250;
  const r = await h.dispatch(s.matchId, 'STEP', input());
  assert.equal(r.confirmations, 1); assert.equal(r.snapshot.version, 1); assert.equal(r.snapshot.data.lap, 1);
  assert.equal(r.snapshot.data.progress, 25); assert.equal(r.snapshot.data.speed, 54);
  assert.deepEqual(r.snapshot.data.hit, []); assert.deepEqual(r.snapshot.data.lapTimes, [250]);
  assert.equal(r.snapshot.data.lapStarted, 1250);
  assert.deepEqual(h.batches[0].map((e) => e.type), ['OBSTACLE_HIT', 'LAP_COMPLETED']);
  assert.deepEqual(h.batches[0][1].data, { lap: 1, durationMs: 250 });
});

test('three full laps match historical unrounded physics/event sequence and close exactly once', async (t) => {
  const h = await setup(t); let s = await h.start();
  const legacyEvents = [], legacy = new Racing((e) => legacyEvents.push(e), () => h.control.now);
  for (let i = 0; i < 500 && s.state === 'running'; i++) {
    h.control.now += 250;
    const payload = input();
    await legacy.action(payload);
    s = (await h.dispatch(s.matchId, 'STEP', payload)).snapshot;
    for (const key of ['lap', 'speed', 'progress', 'lane', 'collisions', 'lastTick', 'lapStarted', 'lapTimes', 'result']) {
      assert.deepEqual(s.data[key], legacy[key], `${key}: historical physics diverged on step ${i}`);
    }
    assert.deepEqual(s.data.hit, [...legacy.hit]);
  }
  assert.equal(s.state, 'finished'); assert.equal(s.data.result, 'race_completed'); assert.equal(s.data.lap, 3);
  assert.equal(s.data.lapTimes.length, 3); assert.ok(s.data.lapTimes.every((n) => Number.isSafeInteger(n) && n > 0));
  const projection = (events) => events.map(({ type, data, playerId }) => ({ type, data, playerId }));
  assert.deepEqual(projection(h.events), projection(legacyEvents));
  await h.manager.finish(s.matchId); assert.equal(h.events.filter((e) => e.type === 'MATCH_FINISHED').length, 1);
  assert.equal((await h.dispatch(s.matchId, 'STEP', input())).error.code, 'INVALID_LIFECYCLE');
});

test('replay and VERSION_CONFLICT do not read clock, advance physics, or duplicate lap events', async (t) => {
  const h = await setup(t); let now = 1000, calls = 0;
  h.control.clockFactory = () => () => { calls++; return now; };
  h.control.initial = { ...initial(), progress: 1180, speed: 180 };
  const s = await h.start(); now = 1250;
  const action = { requestId: 'lap', type: 'STEP', payload: input(), expectedVersion: 0 };
  const result = await h.manager.dispatch(s.matchId, action);
  now = 1500; await h.dispatch(s.matchId, 'STEP', input());
  const count = calls;
  assert.deepEqual(await h.manager.dispatch(s.matchId, action), result);
  assert.equal((await h.dispatch(s.matchId, 'STEP', input(), { expectedVersion: 0 })).error.code, 'VERSION_CONFLICT');
  assert.equal(calls, count); assert.equal(h.events.filter((e) => e.type === 'LAP_COMPLETED').length, 1);
});

test('rejected lap batch preserves confirmed physics and clock; new request continues from last accepted tick', async (t) => {
  const h = await setup(t);
  h.control.initial = { ...initial(), progress: 1180, speed: 180, obstacles: [{ position: 1190, lane: 2 }] };
  const s = await h.start(); h.control.now = 1250;
  h.sink.before = async () => { throw new Error('sink failure'); };
  const failed = await h.dispatch(s.matchId, 'STEP', input());
  assert.equal(failed.error.code, 'EVENT_ACCEPTANCE_FAILED'); assert.equal(failed.committed, false);
  assert.deepEqual(failed.snapshot.data, s.data); assert.equal(failed.snapshot.version, 0); assert.equal(h.events.length, 1);
  h.sink.before = async () => {}; h.control.now = 1500;
  const retry = await h.dispatch(s.matchId, 'STEP', input());
  assert.equal(retry.snapshot.data.lapStarted, 1500); assert.equal(retry.snapshot.data.lastTick, 1500);
  assert.deepEqual(retry.snapshot.data.lapTimes, [500]); assert.equal(retry.snapshot.data.progress, 25);
});

test('clock dependencies are independent; invalid/backward time cannot change confirmed data; abandonment has no fake result', async (t) => {
  const h = await setup(t); const clocks = [];
  h.control.clockFactory = () => { const record = { now: 1000 }; clocks.push(record); return () => record.now; };
  const first = await h.start();
  const other = new GameInstanceManager(h.factory, { eventSink: h.sink });
  const p = await other.create('racing'), second = await other.activate(p.matchId);
  clocks[0].now = 1250; await h.dispatch(first.matchId, 'STEP', input());
  assert.deepEqual((await other.getSnapshot(second.matchId)).data, second.data);
  const before = await h.manager.getSnapshot(first.matchId);
  for (const time of [0, NaN, 1250.5]) {
    clocks[0].now = time;
    const failed = await h.dispatch(first.matchId, 'STEP', input());
    assert.equal(failed.outcome, 'dependency_failed'); assert.equal(failed.committed, false); assert.deepEqual(failed.snapshot.data, before.data);
  }
  const closed = await h.manager.finish(first.matchId, { reason: 'abandoned' });
  assert.equal(closed.data.result, null); assert.deepEqual(closed.data, before.data);
});
