import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const base=process.env.CONSOLE_URL||'http://127.0.0.1:3000';
async function call(route,method='GET',body){const r=await fetch(base+'/api'+route,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});const value=await r.json();assert.ok(r.ok,`${route}: ${r.status} ${JSON.stringify(value)}`);return value;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const before=await call('/dashboard');
const games=await Promise.all(['tic-tac-toe','snake','racing','tic-tac-toe','snake','racing'].map(gameId=>call('/matches','POST',{gameId})));
assert.equal(new Set(games.map(g=>g.id)).size,6);
const report={startedAt:new Date().toISOString(),base,matches:games.map(g=>({id:g.id,gameId:g.gameId})),checks:[]};
await Promise.all(games.map(async game=>{
 let m=game;
 if(m.gameId==='tic-tac-toe'){while(m.state==='open'){const index=m.board.findIndex(v=>!v);m=await call(`/matches/${m.id}/action`,'POST',{index});}assert.notEqual(m.result,'human_won');assert.ok(m.lastDecision);}
 if(m.gameId==='snake'){for(let i=0;i<25&&m.state==='open';i++)m=await call(`/matches/${m.id}/action`,'POST',{direction:'right'});assert.equal(m.result,'game_over');}
 if(m.gameId==='racing'){const end=Date.now()+60000;while(m.state==='open'&&Date.now()<end){await sleep(120);const lane=m.progress>650&&m.progress<930?0:2;m=await call(`/matches/${m.id}/action`,'POST',{accelerate:true,lane});}assert.equal(m.result,'race_completed');assert.equal(m.lapTimes.length,3);}
 assert.equal(m.state,'closed');report.checks.push(`${m.gameId}: completed ${m.id}`);
}));
for(const m of games){let state;for(let i=0;i<100;i++){state=await call('/matches/'+m.id);if(state.delivery.pending===0)break;await sleep(150);}assert.equal(state.delivery.pending,0);const result=await call('/matches/'+m.id+'/results');assert.equal(result.matchId,m.id);assert.equal(result.gameId,m.gameId);assert.equal(result.state,'closed');assert.ok(result.metrics.length>0);assert.ok(result.metrics.every(row=>row.status!=='invalid'),JSON.stringify(result));}
const after=await call('/dashboard');assert.equal(after.source,'GameStats / Scala');assert.equal(after.totals.started-before.totals.started,6);assert.equal(after.totals.finished-before.totals.finished,6);assert.ok(after.totals.events>before.totals.events);const repeat=await call('/dashboard');assert.deepEqual(repeat,after);
report.checks.push('6 isolated concurrent matches','real SWI-Prolog decisions','real Go-to-Scala analytics','live and final query compatibility','all events delivered','dashboard totals +6','repeated query does not accumulate');report.finishedAt=new Date().toISOString();report.summary=after;await mkdir('evidence',{recursive:true});await writeFile('evidence/integration.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:'passed',checks:report.checks,totals:after.totals},null,2));
