import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,snapshot,deferred,settle} from './helpers/web-games.mjs';

test('Circuito renders lane, obstacles, zero completed laps, times, speed and collisions',()=>{
  const h=setup('racing');assert.equal(h.node('laps').textContent,'0 / 3');assert.ok(h.node('canvas').draws.some(d=>d[0]==='fillRect'&&d[4]===15));
  const s=snapshot('racing');s.version=2;s.data.speed=45.7;s.data.lap=1;s.data.lapTimes=[12345];s.data.collisions=1;h.bridge.publish(s);
  assert.equal(h.node('speed').textContent,'46');assert.equal(h.node('laps').textContent,'1 / 3');assert.match(h.node('times').textContent,/12.35 s/);assert.ok(h.node('track').classes.has('flash'));assert.equal(h.controller.snapshot.data.speed,45.7);h.controller.dispose();
});
test('Circuito keyboard and touch produce only the three STEP fields, one action in flight',async()=>{
  const h=setup('racing'),d=deferred();h.bridge.handler=()=>d.promise;await h.controller.start();assert.equal([...h.clock.jobs.values()][0].delay,180);
  h.window.fire('keydown',{key:'ArrowRight'});h.window.fire('keydown',{key:'w'});await h.clock.step();assert.deepEqual(h.bridge.calls[0].payload,{lane:2,accelerate:true,brake:false});
  await h.controller.tick();assert.equal(h.bridge.calls.length,1);h.window.fire('keyup',{key:'w'});h.doc.pedals[1].fire('pointerdown',{pointerId:1});
  d.resolve({outcome:'completed',committed:true,confirmations:1});await settle();await h.clock.step();assert.equal(h.bridge.calls[1].payload.brake,true);assert.equal(h.bridge.calls[1].payload.accelerate,false);
  h.doc.pedals[1].fire('pointercancel');assert.equal(h.controller.brake,false);h.controller.dispose();
});
test('Circuito completion, blur, detach and pagehide clear controls and timers',async()=>{
  const h=setup('racing');await h.controller.start();h.window.fire('keydown',{key:'w'});h.window.fire('blur');assert.equal(h.controller.accelerate,false);assert.equal(h.clock.jobs.size,0);
  const s=snapshot('racing');s.version=20;s.state='finished';s.data.lap=3;s.data.result='race_completed';h.bridge.publish(s);assert.equal(h.node('result').textContent,'¡Carrera completada!');await h.controller.start();assert.equal(h.clock.jobs.size,0);
  h.bridge.emit('detach',{reason:'removed'});h.window.fire('pagehide');assert.equal(h.bridge.disposed,true);assert.equal(h.window.listenerCount,0);assert.equal(h.view.listeners.length,0);
});
test('Circuito rejected or dependency_failed action stops emission and keeps confirmed snapshots',async()=>{
  for(const outcome of ['rejected','dependency_failed']){const h=setup('racing');h.bridge.handler=async()=>({outcome,committed:outcome==='dependency_failed',confirmations:outcome==='dependency_failed'?1:0,error:{code:'VERSION_CONFLICT'}});await h.controller.start();await h.clock.step();assert.equal(h.bridge.calls.length,1);assert.equal(h.clock.jobs.size,0);assert.equal(h.controller.snapshot.version,0);h.controller.dispose();}
});

test('Circuito starts on first focus/click, and resynchronizes after losing focus',async()=>{
  const h=setup('racing');h.window.fire('focus');await h.controller.start();assert.equal(h.controller.armed,true);assert.equal(h.bridge.reads,1);
  h.window.fire('blur');h.window.fire('focus');assert.equal(h.clock.jobs.size,0);await h.controller.start();assert.equal(h.bridge.reads,2);assert.equal(h.clock.jobs.size,1);h.controller.dispose();
});
