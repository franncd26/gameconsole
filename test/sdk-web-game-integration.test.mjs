import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { prepareSDK } from '../server/sdk/bootstrap.mjs';
import { createApp } from '../server/index.mjs';
import { HostBridge } from '../public/sdk/bridge/host-bridge.mjs';
import { createGameBridgeClient } from '../public/sdk/bridge/game-client.mjs';
import { GatoController } from '../plugins/tic-tac-toe/web/controller.mjs';
import { GatoView } from '../plugins/tic-tac-toe/web/view.mjs';
import { SnakeController } from '../plugins/snake/web/controller.mjs';
import { SnakeView } from '../plugins/snake/web/view.mjs';
import { RacingController } from '../plugins/racing/web/controller.mjs';
import { RacingView } from '../plugins/racing/web/view.mjs';
import { windows } from './helpers/bridge.mjs';
import { Document, Clock, setup, deferred, settle } from './helpers/web-games.mjs';

const games=['tic-tac-toe','snake','racing'];
test('slow Snake cannot block Circuito or leak snapshots/identity into Gato',async()=>{
  const snake=setup('snake'),racing=setup('racing'),gato=setup('tic-tac-toe'),d=deferred();
  snake.bridge.handler=()=>d.promise;await snake.controller.start();await snake.clock.step();
  await racing.controller.start();await racing.clock.step();assert.equal(racing.bridge.calls.length,1);assert.equal(snake.bridge.calls.length,1);assert.equal(gato.bridge.calls.length,0);
  snake.bridge.emit('snapshot',racing.bridge.snapshot);assert.equal(snake.controller.snapshot.gameId,'snake');
  snake.controller.dispose();d.resolve({outcome:'completed',committed:true,confirmations:1});await settle();
  assert.equal(racing.controller.connected,true);assert.equal(gato.controller.connected,true);racing.controller.dispose();gato.controller.dispose();
});
test('web packages use only relative resources and public Bridge, never HTTP, analytics or server rules',async()=>{
  for(const game of games){
    const root=new URL('../plugins/'+game+'/web/',import.meta.url);
    const html=await readFile(new URL('index.html',root),'utf8');
    assert.match(html,/href="\.\/styles\.css"/);assert.match(html,/src="\.\/app\.mjs"/);
    assert.doesNotMatch(html,/\s(?:style|on[a-z]+)=|<script[^>]*>\s*[^<\s]/i);
    const files=await readdir(root);
    for(const file of files){const bytes=await readFile(new URL(file,root));assert.ok(bytes.length<=1024*1024);
      if(!file.endsWith('.mjs'))continue;const text=bytes.toString();
      assert.doesNotMatch(text,/\bfetch\s*\(|XMLHttpRequest|\/api\/sdk|GameStats|emitEvent|confirmTransition|parent\.(document|location)|node:|Rules|Session/);
      for(const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g))assert.ok(match[1]==='/sdk/bridge/game-client.mjs'||/^\.\/[a-z-]+\.mjs$/.test(match[1]),match[1]);
    }
  }
});

test('three real views and Bridge channels run against generic HTTP/SDK; ESM/CSS served with sandbox CSP',async(t)=>{
  const events=[];
  const sdk=await prepareSDK({pluginsDirectory:fileURLToPath(new URL('../plugins/',import.meta.url)),trustedIds:games});
  const app=createApp({sdk,statsURL:'http://go.test',statsFetcher:async(_url,init)=>{events.push(JSON.parse(init.body));return new Response('{}',{status:201});}});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  const base='http://127.0.0.1:'+app.server.address().port;
  const api=async(route,body)=>{const r=await fetch(base+'/api/sdk/'+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok);return r.json();};
  const pair=windows(),host=new HostBridge({window:pair.host,fetcher:(url,init)=>fetch(base+url,init)}),controllers=[],channels=[];
  t.after(async()=>{controllers.forEach(c=>c.dispose());host.dispose();app.outbox.stop();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
  const types=[[GatoController,GatoView],[SnakeController,SnakeView],[RacingController,RacingView]];
  for(const [index,game] of games.entries()){
    const s=await api('matches',{gameId:game});const p=index===0?pair:windows(pair.host);
    host.attach(p.frame,s,{loaded:true});const bridge=createGameBridgeClient({window:p.game,hostOrigin:'http://console.test'});
    await new Promise(resolve=>{const off=bridge.onInit(()=>{queueMicrotask(()=>off());resolve();});});
    const doc=new Document(game),[Controller,View]=types[index];
    const c=new Controller({bridge,view:new View(doc),window:p.game,document:doc,clock:new Clock()});controllers.push(c);channels.push({p,bridge,doc,s});
    assert.equal(c.snapshot.matchId,s.matchId);assert.equal(c.snapshot.state,'running');
    for(const [file,mime]of[['','text/html'],['app.mjs','text/javascript'],['controller.mjs','text/javascript'],['view.mjs','text/javascript'],['styles.css','text/css']]){
      const r=await fetch(base+'/sdk/web/'+game+'/'+file);assert.equal(r.status,200);assert.ok(r.headers.get('content-type').startsWith(mime));assert.equal(r.headers.get('access-control-allow-origin'),'*');assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'self'/);assert.doesNotMatch(r.headers.get('content-security-policy'),/unsafe-inline|unsafe-eval/);
    }
  }
  const snake=controllers[1],racing=controllers[2];
  await Promise.all([snake.act('TICK',{direction:'up'}),racing.act('STEP',{lane:2,accelerate:true,brake:false})]);
  assert.equal(snake.snapshot.version,1);assert.equal(racing.snapshot.version,1);assert.equal(snake.snapshot.data.body[0].y,channels[1].s.data.body[0].y-1);assert.equal(racing.snapshot.data.lane,2);
  assert.equal(controllers[0].snapshot.version,0,'Gato stays active without starting Prolog');
  const sent=channels[1].p.outbound.find(m=>m.data.type==='ACTION_REQUEST').data;
  const replay=await channels[1].bridge.dispatch('TICK',{direction:'up'},{messageId:sent.messageId});assert.equal(replay.snapshot.version,1);
  await channels[1].bridge.requestSnapshot();assert.equal(snake.snapshot.version,1);
  await api('matches/'+snake.snapshot.matchId+'/finish',{});await channels[1].bridge.requestSnapshot();assert.equal(snake.snapshot.state,'finished');
  host.unmount(channels[1].p.frame);await Promise.resolve();assert.equal(snake.connected,false);assert.equal(racing.connected,true);assert.equal(controllers[0].connected,true);
  await racing.act('STEP',{lane:0,accelerate:false,brake:true});assert.equal(racing.snapshot.version,2);
  await app.outbox.flush(1000);assert.equal(events.filter(e=>e.type==='MATCH_STARTED').length,3);assert.equal(events.filter(e=>e.type==='MATCH_FINISHED').length,1);
  assert.equal(new Set(events.map(e=>e.eventId)).size,events.length);
});
