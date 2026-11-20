import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.mjs';
import { prepareSDK } from '../server/sdk/bootstrap.mjs';
import { ConsoleAPI } from '../public/sdk/console-api.mjs';
import { ConsoleApp } from '../public/sdk/console-app.mjs';
import { Document, Window, Bridge, Clock, dashboard, deferred } from './helpers/console-dom.mjs';

async function application(t, enabled = true) {
  const events = [], state = { gate: null, status: 200, queries: [] };
  const sdk = enabled ? await prepareSDK({ pluginsDirectory: fileURLToPath(new URL('../plugins/', import.meta.url)), trustedIds: ['tic-tac-toe','snake','racing'] }) : undefined;
  const app = createApp({ sdk, statsURL: 'http://go.test', statsFetcher: async (url, init) => {
    const route = new URL(url).pathname; state.queries.push(route);
    if (route === '/events') { if (state.gate) await state.gate.promise; events.push(JSON.parse(init.body)); return new Response('{}', { status:201 }); }
    if (state.status !== 200) return new Response('{"error":"/private/analysis trace"}', { status: state.status });
    if (route === '/dashboard') return Response.json(dashboard);
    const [, , gameId, matchId] = route.split('/'), closed = events.some(e => e.matchId === matchId && e.type === 'MATCH_FINISHED');
    return Response.json({ gameId, matchId, state: closed ? 'closed' : 'open', metrics: [{ id:'fixture.metric',label:'Métrica de Scala (doble)',scope:'match',subjectId:matchId,value:123,unit:'events',status:closed?'final':'provisional',basis:{eventCount:events.filter(e=>e.matchId===matchId).length},source:{templateId:'event-metrics/v1',instanceId:'fixture',profileVersion:'1.0.0'}}],patterns:[] });
  } });
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{state.gate?.resolve();app.outbox.stop();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
  const base='http://127.0.0.1:'+app.server.address().port;
  return { app, base, events, state, api:new ConsoleAPI((route,init)=>fetch(base+route,init)) };
}
test('root and ?match serve SDK console only when enabled; historical root/catalog/assets stay functional',async t=>{
  for(const enabled of [false,true]){
    const h=await application(t,enabled);
    for(const route of ['/', '/?match=existing']){const response=await fetch(h.base+route);assert.equal(response.status,200);assert.equal(response.redirected,false);const html=await response.text();assert.match(html,enabled?/\/sdk\/console.mjs/:/src="\/app.mjs"/);assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(response.headers.get('content-security-policy'),/frame-src 'self'/);}
    assert.equal((await fetch(h.base+'/api/catalog')).status,200);assert.equal((await fetch(h.base+'/app.mjs')).status,200);
    const explicit=await fetch(h.base+'/sdk/console.html');assert.equal(explicit.status,200);
    assert.equal((await fetch(h.base+'/?match=existing',{method:'HEAD'})).status,200);
    if(!enabled)await assert.rejects(h.api.catalog(),{code:'SDK_DISABLED'});
  }
});
test('new console resources have valid MIME/CSP and no hardcoded plugin decisions or inline code',async t=>{
  const h=await application(t);
  for(const file of ['console.mjs','console-app.mjs','console-api.mjs','console-stats.mjs','console-views.mjs','console.css']){
    const response=await fetch(h.base+'/sdk/'+file);assert.equal(response.status,200);assert.ok(response.headers.get('content-type').startsWith(file.endsWith('.css')?'text/css':'text/javascript'));
    const source=await response.text();assert.doesNotMatch(source,/tic-tac-toe|\bsnake\b|\bracing\b|PLACE_MARK|RETRY_AI|COMPLETE_LAP|\bTICK\b|\bSTEP\b|innerHTML|localhost|127\.0\.0\.1/);
  }
  const html=await readFile(new URL('../public/sdk/console.html',import.meta.url),'utf8');assert.doesNotMatch(html,/\s(?:style|onclick)=|<script[^>]*>\s*[^<\s]/i);
});
test('console facade + authentic SDK handles pending results, real identities, parallel games, analytics outage and final metrics without Prolog',async t=>{
  const h=await application(t),document=new Document(),window=new Window(),bridge=new Bridge(),clock=new Clock();
  const consoleApp=new ConsoleApp({document,window,bridge,clock,api:h.api});t.after(()=>consoleApp.dispose());await consoleApp.init();
  h.state.gate=deferred();await consoleApp.create('snake',{size:12});const snakeId=consoleApp.selectedId;
  await consoleApp.results.inFlight;assert.equal(consoleApp.results.state.status,'pending');assert.equal(consoleApp.results.state.data,null);
  h.state.gate.resolve();await h.app.outbox.flush(1000);h.state.gate=null;await consoleApp.results.refresh();assert.equal(consoleApp.results.state.data.metrics[0].value,123);assert.match(document.getElementById('results').textContent,/provisional/);
  await consoleApp.create('racing',{});const racingId=consoleApp.selectedId;assert.notEqual(racingId,snakeId);assert.equal(consoleApp.workspace.records.size,2);
  const frame=consoleApp.workspace.records.get(snakeId).frame;
  await consoleApp.select(snakeId);await consoleApp.results.inFlight;assert.equal(consoleApp.workspace.records.get(snakeId).frame,frame);
  h.state.status=503;await consoleApp.results.refresh();assert.equal(consoleApp.results.state.status,'failed');assert.equal(bridge.unmounts.length,0);assert.ok(!document.getElementById('result-status').textContent.includes('/private'));
  h.state.status=200;await consoleApp.finish(snakeId);await h.app.outbox.flush(1000);await consoleApp.results.inFlight;await consoleApp.results.refresh();
  assert.equal(consoleApp.results.state.data.state,'closed');assert.equal(consoleApp.results.state.data.metrics[0].status,'final');assert.equal(consoleApp.workspace.records.get(snakeId).frame,frame);assert.ok(bridge.refreshes.includes(frame));assert.equal((await h.api.snapshot(racingId)).state,'running');
  await consoleApp.dashboard.inFlight;await consoleApp.dashboard.refresh();assert.equal(consoleApp.dashboard.state.data.totals.started,77,'official count is not recomputed from two SDK sessions');
  assert.equal(h.events.filter(e=>e.type==='MATCH_FINISHED').length,1);assert.equal(new Set(h.events.map(e=>e.eventId)).size,h.events.length);
});
