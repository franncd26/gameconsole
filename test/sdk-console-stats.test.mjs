import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleAPI } from '../public/sdk/console-api.mjs';
import { PollResource } from '../public/sdk/console-stats.mjs';
import { StatsPanel, displayValue } from '../public/sdk/console-views.mjs';
import { Document, Clock, dashboard, deferred, settle, plugin } from './helpers/console-dom.mjs';

test('poller never overlaps one resource, bounds cadence after completion and observer copies are independent', async () => {
  const clock = new Clock(), gate = deferred(); let calls = 0;
  const poll = new PollResource({ clock, interval: 3000, task: async () => { calls++; await gate.promise; return { status:200, data:{ n:9 } }; } });
  poll.subscribe(s => { if(s.data)s.data.n=999; }); const first=poll.setKey('a'); await settle(); poll.refresh(); poll.refresh(); assert.equal(calls,1); assert.equal(clock.jobs.size,0);
  gate.resolve(); await first; assert.equal(poll.state.data.n,9); assert.equal([...clock.jobs.values()][0].delay,3000); await clock.next(); assert.equal(calls,2); poll.dispose(); assert.equal(clock.jobs.size,0);
});
test('selection invalidates late A response, starts only selected B after prior request settles', async () => {
  const clock = new Clock(), gate = deferred(), calls=[];
  const poll = new PollResource({clock,interval:3000,task: async id=>{calls.push(id);if(id==='a')await gate.promise;return {status:200,data:{id}};}});
  poll.setKey('a'); await settle(); poll.setKey('b'); assert.equal(poll.state.data,null); assert.deepEqual(calls,['a']);gate.resolve();await settle();assert.deepEqual(calls,['a','b']);assert.equal(poll.state.data.id,'b');poll.dispose();
});
test('202 is pending without fabricated zero; failed refresh retains explicitly stale last success', async () => {
  const clock=new Clock();let status=200;
  const poll=new PollResource({clock,interval:3000,now:()=> 'known-time',task:async()=>{if(status===503)throw {status:503,code:'ANALYTICS_UNAVAILABLE'};return {status,data:{value:42}};}});
  await poll.setKey('a');status=503;await poll.refresh();assert.equal(poll.state.status,'failed');assert.equal(poll.state.data.value,42);assert.equal(poll.state.lastSuccess,'known-time');status=202;await poll.refresh();assert.equal(poll.state.data,null);assert.equal(poll.state.status,'pending');poll.dispose();
});
test('hidden tab aborts/discards response, resumes once, disposal stops timers', async () => {
  let hidden=false;const gate=deferred(),clock=new Clock();let calls=0;
  const poll=new PollResource({clock,interval:5000,hidden:()=>hidden,task:async()=>{calls++;await gate.promise;return{status:200,data:{calls}};}});
  poll.setKey('dashboard');await settle();hidden=true;poll.visibilityChanged();gate.resolve();await settle();assert.equal(poll.state.data,null);assert.equal(clock.jobs.size,0);hidden=false;poll.visibilityChanged();await settle();assert.equal(calls,2);assert.equal([...clock.jobs.values()][0].delay,5000);poll.dispose();
});
test('results facade preserves 200/202 and sanitizes 404/502/503/504 and network errors',async()=>{
  for(const status of [200,202,404,502,503,504]){const body=status===200?{gameId:'any',matchId:'id/encoded',state:'open',metrics:[],patterns:[]}:status===202?{status:'pending'}:{error:{code:'ANALYTICS_UNAVAILABLE',message:'C:\\secret\\trace'}};
    const api=new ConsoleAPI(async()=>new Response(JSON.stringify(body),{status}));
    if(status<300)assert.equal((await api.results('id/encoded')).status,status);
    else await assert.rejects(api.results('id'),e=>e.status===status&&!e.message.includes('secret'));
  }
  await assert.rejects(new ConsoleAPI(async()=>{throw Error('/private');}).dashboard(),e=>!e.message.includes('private'));
});
test('dashboard keeps official counts and aggregate values verbatim, warns invalid samples and shows no-data catalog games',async()=>{
  const api=new ConsoleAPI(async()=>new Response(JSON.stringify(dashboard))); const received=await api.dashboard(); assert.deepEqual(received.data,dashboard);
  const document=new Document(),panel=new StatsPanel({document,results:document.getElementById('results'),dashboard:document.getElementById('dashboard'),resultStatus:document.getElementById('rs'),dashboardStatus:document.getElementById('ds')});
  panel.setCatalog([plugin(),plugin('future-game')]);panel.renderDashboard({status:'updated',data:received.data});const text=document.getElementById('dashboard').textContent;
  assert.match(text,/Instancias iniciadas: 77/);assert.match(text,/Activas: 60/);assert.match(text,/901/);assert.match(text,/321/);assert.match(text,/2 muestras/);assert.match(text,/Nombre future-game/);assert.match(text,/Sin datos disponibles/);assert.match(text,/per_match_snapshot/);
});
test('metric/pattern renderer keeps null, structured values, statuses, units, reason and basis using text nodes',()=>{
  const d=new Document(),panel=new StatsPanel({document:d,results:d.getElementById('r'),dashboard:d.getElementById('dash'),resultStatus:d.getElementById('s'),dashboardStatus:d.getElementById('ds')});
  panel.renderResults({status:'updated',data:{gameId:'any',matchId:'a',state:'open',metrics:[{label:'<img onerror=attack>',value:null,scope:'player',subjectId:'human',unit:'seconds',status:'unavailable',reason:'no_samples',basis:{eventCount:7}},{label:'Resultado estructurado',value:{outcome:'in_progress',winnerId:null},status:'provisional'}],patterns:[{label:'Patrón',count:0,status:'final',occurrences:[]} ]}});
  const text=d.getElementById('r').textContent;for(const value of ['<img onerror=attack>','Sin dato (null)','no_samples','7 eventos','human','seconds','provisional','final','in_progress'])assert.ok(text.includes(value),value);
  assert.equal(displayValue(0),'0');assert.equal(displayValue(null),'Sin dato (null)');
});
