import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSDKIntegration } from '../scripts/sdk-compose-integration.mjs';

// Contract fixtures only: this fake never executes game logic, Prolog, Go or Scala.
function transport(options = {}) {
  const matches = new Map(), calls = [], cached = new Map(), pending = new Set(); let serial = 0;
  const clone = value => structuredClone(value);
  const delivery = s => ({ ...clone(s), delivery: { pending: 0, delivered: s.eventIds.length } });
  const summary = () => ({ source: options.simulated ? 'SIMULADO · sin Go/Scala' : 'GameStats / Scala', consistency: 'per_match_snapshot', scope: 'current_process',
    totals: { started: matches.size, active: [...matches.values()].filter(s => s.state === 'running').length, finished: [...matches.values()].filter(s => s.state === 'finished').length, events: [...matches.values()].reduce((n,s) => n + s.eventIds.length, 0) },
    games: ['tic-tac-toe','snake','racing'].map(gameId => ({ gameId })),
    matches: [...matches.values()].map(s => ({ gameId: s.gameId, matchId: s.matchId, state: s.state === 'finished' ? 'closed' : 'open' })) });
  const analysis = s => {
    const closed = s.state === 'finished', live = closed ? 'final' : 'provisional';
    const basis = { eventCount: options.badBasis ? 999 : s.eventIds.length, lastEventId: s.eventIds.at(-1) };
    const metric = (id, instanceId, value, status = live, extra = {}) => ({ id, scope: 'match', subjectId: s.matchId, value, status, basis,
      source: { templateId: 'event-metrics/v1', instanceId, profileVersion: '1.0.0' }, ...extra });
    const rows = s.gameId === 'tic-tac-toe' ? [metric('moves.match','moves',2), metric('board.result','board', closed ? null : { outcome:'in_progress',winnerId:null }, closed ? 'unavailable' : live,
      { ...(closed ? {reason:'insufficient_evidence'} : {}), source:{analyzerId:'tic-tac-toe-line/v1',instanceId:'board',profileVersion:'1.0.0'} })]
      : s.gameId === 'snake' ? [metric('apples.match','apples',0),metric('points.player','apples',0,live,{scope:'player',subjectId:'human'})]
      : [metric('laps.match','laps',0),metric('lap_time.avg.player','laps',null,'unavailable',{scope:'player',subjectId:'human',reason:'no_samples'})];
    rows.push(metric('duration.match','duration',closed ? 1 : null,closed ? 'final' : 'unavailable',{...(closed ? {} : {reason:'awaiting_finish'}),source:{templateId:'duration/v1',instanceId:'duration',profileVersion:'1.0.0'}}));
    return {gameId:s.gameId,matchId:s.matchId,state:closed?'closed':'open',metrics:rows,patterns:s.gameId==='snake'?[{id:'apples.burst',status:live,count:0,occurrences:[],basis,source:{templateId:'temporal-window/v1',instanceId:'burst',profileVersion:'1.0.0'}}]:[]};
  };
  const fetcher = async (url, init = {}) => {
    const p = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : null; calls.push({p,body});
    if (p === '/') return new Response('<script src="/sdk/console.mjs"></script>');
    if (p.endsWith('/health')) return Response.json({ status:'ok' });
    if (p.endsWith('/dashboard')) return Response.json(summary());
    if (p === '/api/sdk/catalog') return Response.json(['tic-tac-toe','snake','racing'].map(id => ({id})));
    if (p === '/api/sdk/matches') {
      if (!body) return Response.json([...matches.values()].map(delivery));
      assert.deepEqual(body.options, {});
      const s = {gameId:body.gameId,matchId:'00000000-0000-4000-8000-'+String(++serial).padStart(12,'0'),state:'running',version:0,data:{marker:'initial'},eventIds:['start-'+serial]};
      matches.set(s.matchId,s);
      if (options.unknownCreate === body.gameId) throw Error('/private/after-post');
      return Response.json(delivery(s),{status:201});
    }
    const parts = p.split('/'), id = parts[4], operation = parts[5];
    if (p.startsWith('/matches/')) {
      const s=matches.get(parts[3]);return Response.json({gameId:s.gameId,matchId:s.matchId,state:s.state==='finished'?'closed':'open',eventIds:s.eventIds,eventCount:s.eventIds.length});
    }
    const s=matches.get(id);assert.ok(s, p);
    if (!operation) return Response.json(delivery(s));
    if (operation === 'actions') {
      const key=id+body.requestId;
      if (cached.has(key)) { if(options.duplicateReplay)s.eventIds.push('duplicate');return Response.json(cached.get(key)); }
      assert.equal(body.expectedVersion,0);
      s.version=s.gameId==='tic-tac-toe'?2:1;s.data={marker:'confirmed'};
      if(s.gameId==='tic-tac-toe') {
        assert.equal(body.type,'PLACE_MARK');s.data={board:['X','','','','O','','','',''],turn:2,awaitingAI:false,lastDecision:{index:4,algorithm:'minimax',score:0}};
        if(options.partial){s.version=1;s.data={board:['X','','','','','','','',''],turn:1,awaitingAI:true,lastDecision:null};s.eventIds.push('human');}
        else s.eventIds.push('human','decision','ai');
      }
      const result={outcome:options.partial&&s.gameId==='tic-tac-toe'?'dependency_failed':'completed',committed:true,confirmations:s.gameId==='tic-tac-toe'&&!options.partial?2:1,snapshot:delivery(s)};
      cached.set(key,clone(result));return Response.json(result);
    }
    if (operation === 'finish') {if(s.state!=='finished'){s.state='finished';s.version++;s.eventIds.push('finish-'+id);}return Response.json(delivery(s));}
    if (operation === 'results') {
      if (options.analyticsDown) return Response.json({error:'/private/scala-error'}, {status:503});
      if (options.pending && !pending.has(id)) { pending.add(id); return Response.json({status:'pending'}, {status:202}); }
      return Response.json(analysis(s));
    }
    throw Error('Unknown fixture route');
  };
  return { fetcher, calls, matches };
}
const run = (fixture, extra = {}) => runSDKIntegration({consoleURL:'http://console.test',goURL:'http://go.test',fetcher:fixture.fetcher,evidenceFile:null,timeoutMs:2000,pollMs:100,...extra});

test('deployed-runner contract traverses SDK/Go endpoints, replay, live/final metrics and writes explicitly simulated test evidence',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'sdk-integration-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const fixture=transport(), file=path.join(root,'report.json'); const report=await run(fixture,{evidenceFile:file});
  assert.equal(report.status,'passed',JSON.stringify(report.failure));assert.equal(report.transport,'injected-test-transport');assert.equal(report.matches.length,3);
  assert.ok(report.matches.every(m=>m.final.state==='closed'&&m.finished.state==='finished'));
  assert.ok(fixture.calls.some(c=>c.p.startsWith('/matches/')));assert.ok(fixture.calls.some(c=>c.p==='/api/sdk/matches'&&!c.body));
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),report);
  assert.ok(!JSON.stringify(report).includes('console.test'));
});
test('analysis-double provenance is rejected before creation',async()=>{
  const f=transport({simulated:true}),r=await run(f);assert.equal(r.status,'failed');assert.equal(r.failure.code,'REAL_ANALYTICS_SOURCE_REQUIRED');assert.equal(f.matches.size,0);
});
test('partial Prolog outcome fails with confirmed receipt preserved and cleanup confined to known IDs',async()=>{
  const f=transport({partial:true}),r=await run(f);assert.equal(r.status,'failed');assert.equal(r.failure.stage,'actions-and-prolog');assert.equal(r.failure.code,'REAL_PROLOG_ACTION_NOT_COMPLETED');
  assert.equal(r.matches.find(m=>m.gameId==='tic-tac-toe').action.committed,true);assert.equal(r.cleanup.length,3);assert.ok(r.cleanup.every(m=>m.status==='locally-finished-delivery-not-verified'));
  const confirmed=r.matches.find(m=>m.gameId==='tic-tac-toe').action.snapshot.data;assert.equal(confirmed.board[0],'X');assert.equal(confirmed.awaitingAI,true);assert.equal(confirmed.board.includes('O'),false);
});
test('replay duplicates and a wrong analytic basis each fail at their actual stage',async()=>{
  for(const [options,stage,code]of[[{duplicateReplay:true},'idempotency','REPLAY_DUPLICATED_EVENTS'],[{badBasis:true},'live-delivery-and-analysis','ANALYTICS_BASIS_MISMATCH']]) {
    const r=await run(transport(options));assert.equal(r.status,'failed');assert.equal(r.failure.stage,stage);assert.equal(r.failure.code,code);
  }
});
test('unknown creation waits for other creation responses and never claims rollback of the unknown match',async()=>{
  const f=transport({unknownCreate:'snake'}),r=await run(f);assert.equal(r.status,'failed');assert.equal(r.failure.code,'HTTP_OUTCOME_UNKNOWN');assert.equal(r.matches.length,2);
  assert.equal(r.creation.find(a=>a.gameId==='snake').status,'outcome-unknown');assert.equal(r.cleanup.length,2);assert.equal(f.matches.size,3);assert.equal(r.mutationsMayHaveOccurred,true);assert.ok(!JSON.stringify(r).includes('/private'));
});
test('202 analysis is polled finitely and a 503 is reported as a failed live-analysis stage, never empty metrics',async()=>{
  const f=transport({pending:true}),success=await run(f);assert.equal(success.status,'passed');
  assert.ok(f.calls.filter(c=>c.p.endsWith('/results')).length<12);
  const failed=await run(transport({analyticsDown:true}));assert.equal(failed.status,'failed');assert.equal(failed.failure.stage,'live-delivery-and-analysis');assert.equal(failed.failure.code,'HTTP_503');
  assert.ok(!JSON.stringify(failed).includes('/private'));
});
test('global deadline is enforced for an unresponsive HTTP transport; no services are started',async()=>{
  const r=await run({fetcher:(_url,init)=>new Promise((_,reject)=>{init.signal.addEventListener('abort',()=>reject(Error('private timeout')),{once:true});})},{timeoutMs:1000});
  assert.equal(r.status,'failed');assert.equal(r.failure.code,'GLOBAL_TIMEOUT');assert.equal(r.matches.length,0);
});
