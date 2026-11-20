import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,snapshot,deferred,settle} from './helpers/web-games.mjs';

test('Gato renders confirmed marks, occupied cells, difficulty, winning line and draw',()=>{
  const h=setup('tic-tac-toe');assert.ok(h.doc.cells.every(c=>c.textContent===''&&!c.disabled));assert.equal(h.node('difficulty').textContent,'Minimax');
  const s=snapshot('tic-tac-toe');s.version=2;s.data.board=['X','O','','','','','','',''];s.data.turn=2;h.bridge.publish(s);
  assert.equal(h.doc.cells[0].textContent,'X');assert.equal(h.doc.cells[1].textContent,'O');assert.equal(h.doc.cells[0].disabled,true);
  s.version=4;s.data.winningLine=[0,3,6];s.data.result='human_won';s.state='finished';h.bridge.publish(s);
  assert.equal(h.node('result').textContent,'¡Ganaste!');assert.ok(h.doc.cells[3].classes.has('winner'));assert.ok(h.doc.cells.every(c=>c.disabled));
  s.version=5;s.data.result='draw';h.bridge.publish(s);assert.equal(h.node('result').textContent,'Empate');h.controller.dispose();
});
test('Gato prevents double clicks while dispatch waits and renders only authoritative snapshots',async()=>{
  const h=setup('tic-tac-toe'),d=deferred();h.bridge.handler=()=>d.promise;
  h.doc.cells[0].fire('click');h.doc.cells[1].fire('click');assert.equal(h.bridge.calls.length,1);assert.ok(h.doc.cells.every(c=>c.disabled));
  const s=snapshot('tic-tac-toe');s.version=2;s.data.board[0]='X';s.data.board[4]='O';s.data.turn=2;h.bridge.snapshot=s;
  d.resolve({outcome:'completed',committed:true,confirmations:2,snapshot:snapshot('tic-tac-toe')});await settle();
  assert.equal(h.doc.cells[4].textContent,'O');assert.equal(h.controller.snapshot.version,2);h.controller.dispose();
});
test('Gato preserves partial human move and exposes RETRY_AI only while pending',async()=>{
  const h=setup('tic-tac-toe');assert.equal(h.node('retry-ai').hidden,true);
  h.bridge.handler=async(type)=>{const s=snapshot('tic-tac-toe');s.version=type==='PLACE_MARK'?1:2;s.data.board[0]='X';s.data.turn=s.version;s.data.awaitingAI=type==='PLACE_MARK';if(type==='RETRY_AI')s.data.board[4]='O';h.bridge.snapshot=s;return{outcome:type==='PLACE_MARK'?'dependency_failed':'completed',committed:true,confirmations:1,snapshot:s};};
  await h.controller.mark(0);assert.equal(h.doc.cells[0].textContent,'X');assert.equal(h.node('retry-ai').hidden,false);assert.ok(h.doc.cells.every(c=>c.disabled));
  await h.controller.retryAI();assert.equal(h.bridge.calls[1].type,'RETRY_AI');assert.equal(h.doc.cells[4].textContent,'O');assert.equal(h.node('retry-ai').hidden,true);h.controller.dispose();
});
test('unknown result has no automatic retry; manual replay retains messageId and payload',async()=>{
  const h=setup('tic-tac-toe');h.bridge.handler=async()=>{throw Object.assign(Error('/private/plugin'),{code:'RESULT_UNKNOWN',unknown:true});};
  await h.controller.mark(0);assert.equal(h.bridge.calls.length,1);assert.equal(h.node('replay').hidden,false);assert.ok(!h.node('note').textContent.includes('/private'));
  await h.controller.mark(1);assert.equal(h.bridge.calls.length,1);await h.controller.sync();assert.equal(h.bridge.calls.length,1);
  h.bridge.handler=async()=>({outcome:'completed',committed:true,confirmations:1,snapshot:h.bridge.snapshot});h.node('replay').fire('click');await settle();
  assert.deepEqual(h.bridge.calls[1],h.bridge.calls[0]);assert.equal(h.node('replay').hidden,true);h.controller.dispose();
});
test('Gato VERSION_CONFLICT resynchronizes and closed/detached interfaces send no new actions',async()=>{
  const h=setup('tic-tac-toe');h.bridge.handler=async()=>({outcome:'rejected',committed:false,confirmations:0,error:{code:'VERSION_CONFLICT'}});
  await h.controller.mark(0);assert.equal(h.bridge.reads,1);assert.match(h.node('note').textContent,/VERSION_CONFLICT/);
  h.bridge.publish({...h.bridge.snapshot,version:1,state:'finished'});await h.controller.mark(1);assert.equal(h.bridge.calls.length,1);
  h.bridge.emit('detach',{reason:'removed'});h.window.fire('pagehide');assert.equal(h.window.listenerCount,0);assert.equal(h.bridge.disposed,true);
});
