import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleApp } from '../public/sdk/console-app.mjs';
import { Document, Window, Bridge, Clock, plugin, snapshot, dashboard, deferred, settle } from './helpers/console-dom.mjs';

async function setup(t, matches) {
  const document=new Document(),window=new Window(),bridge=new Bridge(),clock=new Clock();
  const p=plugin('custom-plugin');p.capabilities.multipleInstances=true;
  const stored=new Map(matches.map(s=>[s.matchId,s]));let finishes=0;
  const api={catalog:async()=>[p],matches:async()=>[...stored.values()],snapshot:async id=>structuredClone(stored.get(id)),
    results:async id=>({status:200,data:{gameId:'custom-plugin',matchId:id,state:stored.get(id).state==='finished'?'closed':'open',metrics:[{id:'official',label:'Valor de GameStats',value:812,status:'final',scope:'match',subjectId:id,source:{templateId:'test-double'},basis:{eventCount:7}}],patterns:[]}}),
    dashboard:async()=>({status:200,data:dashboard}),finish:async id=>{finishes++;const s={...stored.get(id),state:'finished',version:stored.get(id).version+1};stored.set(id,s);return s;}};
  const app=new ConsoleApp({document,window,bridge,clock,api});t.after(()=>app.dispose());await app.init();await settle();
  return {app,document,window,bridge,clock,api,stored,get finishes(){return finishes;}};
}
const match=(id,version=0,state='running')=>snapshot(id,'custom-plugin',version,state);

test('focused/grid/internal tabs preserve four iframe nodes and independent channels, without a three-instance limit',async t=>{
  const h=await setup(t,['a','b','c','d'].map(id=>match(id)));
  for(const id of ['a','b','c','d'])await h.app.select(id);
  const frames=[...h.app.workspace.records.values()].map(r=>r.frame);assert.equal(frames.length,4);assert.equal(h.bridge.mounts.length,4);
  assert.equal([...h.app.workspace.records.values()].filter(r=>!r.card.hidden).length,1);
  h.app.setMode('grid');assert.ok([...h.app.workspace.records.values()].every(r=>!r.card.hidden));
  for(const section of ['analytics','library','play'])h.app.setSection(section);
  await h.app.dashboard.refresh();await h.app.results.inFlight;await h.app.select('a');await h.app.results.inFlight;h.app.setMode('focus');
  assert.deepEqual([...h.app.workspace.records.values()].map(r=>r.frame),frames);assert.equal(h.bridge.unmounts.length,0);assert.equal(h.app.workspace.records.get('a').card.hidden,false);
  assert.match(h.document.getElementById('results').textContent,/812/,'analytics is rendered from the service response');
});
test('one console can create four instances sequentially with readable names and no implicit replacement',async t=>{
  const h=await setup(t,[]);let count=0;
  h.api.create=async()=>{const s=match('created-'+(++count));h.stored.set(s.matchId,s);return s;};
  for(let i=0;i<4;i++)await h.app.create('custom-plugin',{});
  assert.equal(h.app.snapshots.size,4);assert.equal(h.bridge.mounts.length,4);assert.equal(h.bridge.unmounts.length,0);
  assert.equal(h.app.workspace.records.get('created-4').title.textContent,'Nombre custom-plugin 4');
  assert.equal(h.app.library.cards.get('custom-plugin').existing,null);
});
test('a list read started before a creation cannot remove or unmount the newly confirmed match',async t=>{
  const h=await setup(t,[]),gate=deferred();let first=true;
  h.api.matches=async()=>{if(first){first=false;await gate.promise;return [];}return [...h.stored.values()];};
  const pending=h.app.sessions.refresh();await settle();
  h.api.create=async()=>{const s=match('new');h.stored.set('new',s);return s;};
  await h.app.create('custom-plugin',{});const frame=h.app.workspace.records.get('new').frame;
  gate.resolve();await pending;await settle();
  assert.equal(h.app.snapshots.has('new'),true);assert.equal(h.app.workspace.records.get('new').frame,frame);assert.equal(h.bridge.unmounts.length,0);
});
test('finished gets a brief terminal screen then releases exactly its channel and moves to non-destructive history',async t=>{
  const h=await setup(t,[match('a'),match('b')]);await h.app.select('b');await h.app.select('a');
  const record=h.app.workspace.records.get('a'),frame=record.frame,other=h.app.workspace.records.get('b').frame;
  await h.app.finish('a');await settle();
  assert.equal(h.finishes,1);assert.equal(record.frame,frame);assert.match(record.banner.textContent,/finalizada/);
  assert.equal(h.app.rows.get('a').node.parentNode,h.document.getElementById('history-list'));
  await h.clock.runDelay(1800);
  assert.equal(record.frame,null);assert.equal(record.retired,true);assert.deepEqual(h.bridge.unmounts,[frame]);
  assert.equal(record.card.parentNode,h.document.getElementById('history-workspace'));assert.equal(h.app.workspace.records.get('b').frame,other);
  assert.equal(h.stored.get('a').state,'finished');assert.equal(h.app.snapshots.get('a').state,'finished');assert.equal(h.finishes,1);
  await h.app.select('a');await h.app.results.inFlight;
  assert.equal(h.bridge.mounts.length,2);assert.equal(record.remount.disabled,true);record.remount.fire('click');await settle();assert.equal(h.bridge.mounts.length,2);
  assert.equal(h.document.getElementById('history').open,true);assert.match(h.document.getElementById('results').textContent,/812/);
});
test('reload prefers active matches and never reconstructs finished iframes, including a finished deep link',async t=>{
  const h=await setup(t,[match('old',2,'finished'),match('live')]);assert.equal(h.app.selectedId,'live');assert.equal(h.bridge.mounts.length,1);assert.equal(h.bridge.mounts[0].snapshot.matchId,'live');
  await h.app.select('old');assert.equal(h.bridge.mounts.length,1);assert.equal(h.app.workspace.records.get('old').frame,null);
  const onlyHistory=await setup(t,[match('past',9,'finished')]);assert.equal(onlyHistory.app.selectedId,null);assert.equal(onlyHistory.bridge.mounts.length,0);assert.equal(onlyHistory.app.workspace.records.size,0);
});
test('terminal retirement invalidates late refresh/selection and cannot mount an old running snapshot',async t=>{
  const h=await setup(t,[match('a')]),gate=deferred();const record=h.app.workspace.records.get('a'),frame=record.frame;
  h.bridge.refresh=()=>gate.promise;
  const read=deferred();h.api.snapshot=()=>read.promise;
  const selecting=h.app.select('a');h.app.accept(match('a',1,'finished'));h.stored.set('a',match('a',1,'finished'));
  await h.clock.runDelay(1800);assert.equal(record.frame,null);
  gate.resolve(true);read.resolve(match('a'));await selecting;await settle();
  assert.equal(record.snapshot.state,'finished');assert.equal(record.frame,null);assert.equal(h.bridge.mounts.length,1);assert.deepEqual(h.bridge.unmounts,[frame]);assert.equal(record.refreshing,false);
});
test('page disposal clears terminal timers and channels; history consultation never invokes finish',async t=>{
  const h=await setup(t,[match('a')]);h.app.accept(match('a',1,'finished'));h.stored.set('a',match('a',1,'finished'));
  assert.ok([...h.clock.jobs.values()].some(j=>j.delay===1800));h.app.dispose();
  assert.equal(h.clock.jobs.size,0);assert.equal(h.bridge.unmounts.length,1);await h.clock.runDelay(1800);assert.equal(h.bridge.unmounts.length,1);assert.equal(h.finishes,0);
});
