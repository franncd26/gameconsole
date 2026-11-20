import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareSDK } from '../server/sdk/bootstrap.mjs';
import { createApp } from '../server/index.mjs';
import { packageHarness } from './helpers/sdk-package.mjs';

test('four real Circuito sessions own their clock, data, versions and events; one finish leaves the others running', async t => {
  const h = await packageHarness(t, 'racing', { entrypoint: `
import plugin from './original-index.mjs';
import { RacingSession } from './racing-session.mjs';
export default {...plugin,createSession(context,options){let now=1000;return {startData:{},session:new RacingSession(context,options,{clock:()=>now+=250})};}};` });
  const matches = await Promise.all(Array.from({length:4},()=>h.start()));
  assert.equal(new Set(matches.map(s=>s.matchId)).size,4);
  for(let turn=0;turn<12;turn++) await Promise.all(matches.map((s,i)=>h.manager.dispatch(s.matchId,{requestId:'step-'+turn,type:'STEP',payload:{lane:i%3,accelerate:true,brake:false},expectedVersion:turn})));
  const snapshots = await Promise.all(matches.map(s=>h.manager.getSnapshot(s.matchId)));
  assert.ok(snapshots.every(s=>s.version===12&&s.state==='running'));
  assert.deepEqual(snapshots.map(s=>s.data.lane),[0,1,2,0]);
  assert.ok(snapshots[1].data.collisions>0);assert.equal(snapshots[0].data.collisions,0);
  assert.ok(h.events.some(e=>e.type==='OBSTACLE_HIT'&&e.matchId===matches[1].matchId));
  const before = snapshots[2];
  await h.manager.dispatch(matches[0].matchId,{requestId:'extra',type:'STEP',payload:{lane:2,accelerate:false,brake:true}});
  assert.deepEqual(await h.manager.getSnapshot(matches[2].matchId),before);
  await h.manager.finish(matches[0].matchId);await h.manager.finish(matches[0].matchId);
  assert.equal(h.events.filter(e=>e.type==='MATCH_FINISHED').length,1);
  for(const s of matches.slice(1))assert.equal((await h.manager.getSnapshot(s.matchId)).state,'running');
  for(const e of h.events){assert.ok(matches.some(s=>s.matchId===e.matchId));assert.equal(e.gameId,'racing');}
  assert.equal(new Set(h.events.map(e=>e.eventId)).size,h.events.length);
  const fifth=await h.start();assert.ok(!matches.some(s=>s.matchId===fifth.matchId));assert.equal(fifth.version,0);
});

async function http(t, exclusive = false) {
  const root=await mkdtemp(path.join(os.tmpdir(),'sdk-multi-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await cp(new URL('../plugins/',import.meta.url),root,{recursive:true});
  // Only a copied adapter is replaced. Production Gato rules/session/adapter remain untouched.
  await writeFile(path.join(root,'tic-tac-toe/server/prolog-adapter.mjs'),`export class PrologFailure extends Error{};export class PrologAdapter{async decide(board,{difficulty}){return {index:[4,0,2,6,8,1,3,5,7].find(i=>!board[i]),algorithm:{easy:'reglas_basicas',medium:'reglas_tacticas',hard:'minimax'}[difficulty],score:difficulty==='hard'?0:null};}}`);
  if(exclusive){const file=path.join(root,'racing/game.json'),m=JSON.parse(await readFile(file));m.id='exclusive-example';m.capabilities.multipleInstances=false;await writeFile(file,JSON.stringify(m));}
  const ids=exclusive?['exclusive-example']:['racing','snake','tic-tac-toe'];
  const sdk=await prepareSDK({pluginsDirectory:root,trustedIds:ids}),events=[],queries=[];
  const app=createApp({sdk,statsURL:'http://go.test',statsFetcher:async(url,init)=>{
    const p=new URL(url).pathname;
    if(p==='/events'){events.push(JSON.parse(init.body));return Response.json({},{status:201});}
    queries.push(p);const[,,gameId,matchId]=p.split('/'),prefix=events.filter(e=>e.matchId===matchId);
    return Response.json({gameId,matchId,state:prefix.some(e=>e.type==='MATCH_FINISHED')?'closed':'open',metrics:[{id:'fixture.received',label:'Dato del doble analítico',scope:'match',subjectId:matchId,value:prefix.length,status:'provisional',source:{templateId:'test-double'},basis:{eventCount:prefix.length}}],patterns:[]});
  }});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{app.outbox.stop();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
  const base='http://127.0.0.1:'+app.server.address().port+'/api/sdk/';
  const client=()=>async(route,body)=>{const r=await fetch(base+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  return {a:client(),b:client(),app,events,queries};
}
test('different HTTP clients create four Circuitos, two Gatos and two Snakes; opening an existing ID never creates a session',async t=>{
  const h=await http(t),create=(client,gameId,options={})=>client('matches',{gameId,options});
  const created=await Promise.all([create(h.a,'racing'),create(h.b,'racing'),create(h.a,'racing'),create(h.b,'racing'),create(h.a,'tic-tac-toe'),create(h.b,'tic-tac-toe'),create(h.a,'snake',{size:12}),create(h.b,'snake',{size:28})]);
  assert.ok(created.every(r=>r.status===201));const matches=created.map(r=>r.body);
  assert.equal(new Set(matches.map(s=>s.matchId)).size,8);assert.equal(h.app.sdk.manager.size,8);
  const [left,right]=await Promise.all([h.a('matches/'+matches[0].matchId),h.b('matches/'+matches[0].matchId)]);
  assert.equal(left.body.matchId,right.body.matchId);assert.equal((await h.a('matches')).body.length,8);
  const action=(s,type,payload)=>({route:'matches/'+s.matchId+'/actions',body:{requestId:'same-request',type,payload,expectedVersion:0}});
  const moves=matches.map((s,i)=>i<4?action(s,'STEP',{lane:i%3,accelerate:true,brake:false}):i<6?action(s,'PLACE_MARK',{index:i===4?0:2}):action(s,'TICK',{direction:i===6?'up':'down'}));
  const outcomes=await Promise.all(moves.map((a,i)=>(i%2?h.b:h.a)(a.route,a.body)));
  assert.ok(outcomes.every(r=>r.status===200&&r.body.outcome==='completed'));
  assert.deepEqual(outcomes.slice(0,4).map(r=>r.body.snapshot.version),[1,1,1,1]);
  assert.equal(outcomes[4].body.snapshot.data.board[0],'X');assert.equal(outcomes[4].body.snapshot.data.board[2],'');assert.equal(outcomes[5].body.snapshot.data.board[2],'X');
  assert.equal(outcomes[6].body.snapshot.data.size,12);assert.equal(outcomes[7].body.snapshot.data.size,28);
  assert.deepEqual((await h.b(moves[4].route,moves[4].body)).body,outcomes[4].body);
  await h.app.outbox.flush(1000);
  for(const s of matches){const result=await h.a('matches/'+s.matchId+'/results');assert.equal(result.status,200);assert.equal(result.body.matchId,s.matchId);assert.equal(result.body.gameId,s.gameId);assert.ok(h.queries.includes('/results/'+s.gameId+'/'+s.matchId));}
  await h.a('matches/'+matches[0].matchId+'/finish',{});await h.b('matches/'+matches[0].matchId+'/finish',{});await h.app.outbox.flush(1000);
  assert.equal(h.events.filter(e=>e.type==='MATCH_STARTED').length,8);assert.equal(h.events.filter(e=>e.type==='MATCH_FINISHED').length,1);
  for(const s of matches.slice(1))assert.equal((await h.a('matches/'+s.matchId)).body.state,'running');
  const identity=new Map(matches.map(s=>[s.matchId,s.gameId]));for(const e of h.events)assert.equal(e.gameId,identity.get(e.matchId));assert.equal(new Set(h.events.map(e=>e.eventId)).size,h.events.length);
});
test('a future installed fixture declaring multipleInstances false still rejects concurrent creation generically',async t=>{
  const h=await http(t,true),results=await Promise.all([h.a('matches',{gameId:'exclusive-example'}),h.b('matches',{gameId:'exclusive-example'})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal(results.find(r=>r.status===409).body.error.code,'MULTIPLE_INSTANCES_DISABLED');assert.equal(h.app.sdk.manager.size,1);
});
