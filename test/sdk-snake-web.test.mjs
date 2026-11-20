import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,snapshot,deferred,settle} from './helpers/web-games.mjs';

test('Snake draws sizes 12/20/28, confirmed body, food and points',()=>{
  for(const size of [12,20,28]){const h=setup('snake'),s=snapshot('snake');s.data.size=size;s.data.points=30;h.bridge.publish(s);
    assert.equal(h.node('size').textContent,size+' × '+size);assert.equal(h.node('points').textContent,'30');
    assert.ok(h.node('canvas').draws.some(d=>d[0]==='arc'));assert.ok(h.node('canvas').draws.filter(d=>d[0]==='fillRect').length>=4);h.controller.dispose();}
});
test('Snake keyboard/touch intent and slow responses never overlap or accumulate ticks',async()=>{
  const h=setup('snake'),d=deferred();h.bridge.handler=()=>d.promise;await h.controller.start();assert.equal([...h.clock.jobs.values()][0].delay,150);
  h.window.fire('keydown',{key:'w'});await h.clock.step();assert.deepEqual(h.bridge.calls[0].payload,{direction:'up'});assert.equal(h.clock.jobs.size,0);
  await h.clock.step();await h.controller.tick();assert.equal(h.bridge.calls.length,1);
  h.doc.directions[3].fire('click');d.resolve({outcome:'completed',committed:true,confirmations:1});await settle();assert.equal(h.clock.jobs.size,1);
  await h.clock.step();assert.equal(h.bridge.calls[1].payload.direction,'right');h.controller.dispose();assert.equal(h.clock.jobs.size,0);
});
test('Snake blur/visibility suspend input; explicit continue resynchronizes before moving',async()=>{
  const h=setup('snake');await h.controller.start();h.window.fire('blur');assert.equal(h.clock.jobs.size,0);assert.equal(h.controller.direction,null);
  h.window.fire('focus');await settle();assert.equal(h.bridge.reads,1);assert.equal(h.clock.jobs.size,0);
  await h.controller.start();assert.equal(h.bridge.reads,2);assert.equal(h.clock.jobs.size,1);h.doc.hidden=true;h.doc.fire('visibilitychange');assert.equal(h.clock.jobs.size,0);
  h.doc.hidden=false;h.doc.fire('visibilitychange');await settle();assert.equal(h.clock.jobs.size,0);h.controller.dispose();
});
test('Snake terminal snapshots and detach stop timers; no stale snapshot rollback',async()=>{
  const h=setup('snake');await h.controller.start();const s=snapshot('snake');s.version=4;s.state='finished';s.data.result='game_over';h.bridge.publish(s);
  assert.equal(h.node('result').textContent,'Fin de partida');assert.equal(h.clock.jobs.size,0);h.bridge.publish(snapshot('snake'));assert.equal(h.controller.snapshot.version,4);
  h.bridge.emit('detach',{reason:'removed'});await h.controller.tick();assert.equal(h.bridge.calls.length,0);h.controller.dispose();assert.equal(h.doc.listenerCount,0);
});
test('Snake failed synchronization cannot restart an automatic loop',async()=>{
  const h=setup('snake');h.bridge.readFailure=Object.assign(Error('private'),{code:'RESULT_UNKNOWN'});await h.controller.start();assert.equal(h.clock.jobs.size,0);assert.equal(h.bridge.calls.length,0);h.controller.dispose();
});

test('consulting a snapshot during automatic play preserves a single scheduled tick',async()=>{
  const h=setup('snake');await h.controller.start();assert.equal(h.clock.jobs.size,1);await h.controller.sync();assert.equal(h.clock.jobs.size,1);await h.clock.step();assert.equal(h.bridge.calls.length,1);h.controller.dispose();
});

test('pagehide during a slow action prevents late rendering and rescheduling',async()=>{
  const h=setup('snake'),d=deferred();h.bridge.handler=()=>d.promise;await h.controller.start();await h.clock.step();
  h.window.fire('pagehide');d.resolve({outcome:'completed',committed:true,confirmations:1});await settle();assert.equal(h.clock.jobs.size,0);assert.equal(h.bridge.reads,1);assert.equal(h.bridge.disposed,true);
});
