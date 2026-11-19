import { randomUUID } from 'node:crypto';

export const CATALOG = [
  {id:'tic-tac-toe',name:'Gato',tag:'ESTRATEGIA',description:'Tu próxima jugada tiene rival. Enfrenta al algoritmo minimax de Prolog.',color:'violet'},
  {id:'snake',name:'Snake',tag:'REFLEJOS',description:'Un movimiento más. Come, crece y encuentra tu camino sin chocar.',color:'lime'},
  {id:'racing',name:'Circuito',tag:'VELOCIDAD',description:'Tres vueltas, una pista. Acelera, cambia de carril y evita los obstáculos.',color:'orange'}
];
export class GameError extends Error { constructor(message,status=400){super(message);this.status=status;} }
export class Match {
  constructor(gameId,emit){this.id=randomUUID();this.gameId=gameId;this.state='open';this.version=0;this.createdAt=new Date().toISOString();this.updatedAt=this.createdAt;this.events=[];this.emit=emit;this.players=['human'];this.result=null;this.lock=Promise.resolve();}
  record(type,data={},playerId){const e={schemaVersion:1,eventId:randomUUID(),timestamp:new Date().toISOString(),gameId:this.gameId,gameVersion:'1.0',matchId:this.id,type,data};if(playerId)e.playerId=playerId;this.events.push(e);this.emit(e);return e;}
  start(data={}){this.record('MATCH_STARTED',{players:this.players,...data});}
  assertOpen(){if(this.state!=='open')throw new GameError('La partida ya terminó.',409);}
  touch(){this.version++;this.updatedAt=new Date().toISOString();}
  finish(reason='completed'){if(this.state==='closed')return;this.state='closed';this.result??=reason;this.record('MATCH_FINISHED',{reason});this.touch();}
  snapshot(){return {id:this.id,gameId:this.gameId,state:this.state,version:this.version,createdAt:this.createdAt,updatedAt:this.updatedAt,result:this.result,eventCount:this.events.length};}
  exclusive(fn){const next=this.lock.then(fn);this.lock=next.catch(()=>{});return next;}
}
export class TicTacToe extends Match {
  static lines=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  constructor(emit,ai){super('tic-tac-toe',emit);this.players=['human','prolog'];this.board=Array(9).fill('');this.turn=0;this.winningLine=[];this.ai=ai;this.lastDecision=null;this.start({symbols:{human:'X',prolog:'O'}});}
  place(index,symbol){if(!Number.isInteger(index)||index<0||index>8||this.board[index])throw new GameError('Selecciona una casilla vacía.');this.board[index]=symbol;this.turn++;this.record('MOVE_PLACED',{turn:this.turn,row:Math.floor(index/3),column:index%3,symbol},symbol==='X'?'human':'prolog');const line=TicTacToe.lines.find(l=>l.every(i=>this.board[i]===symbol));if(line){this.winningLine=line;this.result=symbol==='X'?'human_won':'prolog_won';this.finish();}else if(this.turn===9){this.result='draw';this.finish();}this.touch();}
  async action({index,retryAI=false}){this.assertOpen();if(this.turn%2===0){if(retryAI)throw new GameError('Es tu turno.');this.place(index,'X');}else if(!retryAI)throw new GameError('Falta completar el turno de Prolog. Usa Reintentar IA.',409);if(this.state==='open'){const decision=await this.ai(this.board);if(!Number.isInteger(decision.index)||this.board[decision.index]||decision.index<0||decision.index>8)throw new GameError('Prolog devolvió una jugada inválida.',502);this.lastDecision=decision;this.record('AI_DECISION',{algorithm:'minimax',index:decision.index,score:decision.score,board:[...this.board]},'prolog');this.place(decision.index,'O');}return this.snapshot();}
  snapshot(){return {...super.snapshot(),board:[...this.board],turn:this.turn,winningLine:this.winningLine,lastDecision:this.lastDecision};}
}
const directions={up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]};
export class Snake extends Match {
  constructor(emit,random=Math.random){super('snake',emit);this.size=20;this.body=[{x:6,y:10},{x:5,y:10},{x:4,y:10}];this.direction='right';this.points=0;this.random=random;this.food=this.newFood();this.start();}
  newFood(){const free=[];for(let y=0;y<this.size;y++)for(let x=0;x<this.size;x++)if(!this.body.some(p=>p.x===x&&p.y===y))free.push({x,y});return free.length?free[Math.min(free.length-1,Math.floor(this.random()*free.length))]:null;}
  async action({direction=this.direction}){this.assertOpen();if(!directions[direction])throw new GameError('Dirección inválida.');const old=directions[this.direction],next=directions[direction];if(old[0]+next[0]!==0||old[1]+next[1]!==0)this.direction=direction;const [dx,dy]=directions[this.direction],head={x:this.body[0].x+dx,y:this.body[0].y+dy};const eating=this.food&&head.x===this.food.x&&head.y===this.food.y;const collision=this.body.slice(0,eating?this.body.length:-1).some(p=>p.x===head.x&&p.y===head.y);if(head.x<0||head.y<0||head.x>=this.size||head.y>=this.size||collision){this.record('PLAYER_DIED',{cause:collision?'self_collision':'wall'},'human');this.result='game_over';this.finish();return this.snapshot();}this.body.unshift(head);if(eating){this.points+=10;this.record('APPLE_EATEN',{points:10},'human');this.food=this.newFood();if(!this.food){this.result='board_completed';this.finish();}}else this.body.pop();this.touch();return this.snapshot();}
  snapshot(){return {...super.snapshot(),size:this.size,body:this.body.map(p=>({...p})),food:this.food,direction:this.direction,points:this.points};}
}
export class Racing extends Match {
  constructor(emit,clock=Date.now){super('racing',emit);this.clock=clock;this.lastTick=clock();this.lapStarted=this.lastTick;this.lap=0;this.totalLaps=3;this.progress=0;this.lapLength=1200;this.speed=0;this.lane=1;this.collisions=0;this.lapTimes=[];this.hit=new Set();this.obstacles=[{position:240,lane:1},{position:510,lane:0},{position:790,lane:2},{position:1040,lane:1}];this.start();}
  async action({lane=this.lane,accelerate=false,brake=false}){this.assertOpen();if(!Number.isInteger(lane)||lane<0||lane>2||typeof accelerate!=='boolean'||typeof brake!=='boolean')throw new GameError('Control de carrera inválido.');const now=this.clock(),dt=Math.max(0,Math.min((now-this.lastTick)/1000,0.25));this.lastTick=now;this.lane=lane;this.speed=Math.max(0,Math.min(180,this.speed+(accelerate?65:-18)*dt-(brake?140*dt:0)));const before=this.progress;this.progress+=this.speed*dt;for(const [i,o]of this.obstacles.entries()){if(!this.hit.has(i)&&o.lane===this.lane&&before<o.position&&this.progress>=o.position){this.hit.add(i);this.speed*=0.3;this.collisions++;this.record('OBSTACLE_HIT',{lap:this.lap+1,lane:this.lane},'human');}}if(this.progress>=this.lapLength){const durationMs=Math.max(1,now-this.lapStarted);this.lap++;this.lapTimes.push(durationMs);this.record('LAP_COMPLETED',{lap:this.lap,durationMs},'human');this.progress-=this.lapLength;this.lapStarted=now;this.hit.clear();if(this.lap===this.totalLaps){this.result='race_completed';this.finish();}}this.touch();return this.snapshot();}
  snapshot(){return {...super.snapshot(),lap:this.lap,totalLaps:this.totalLaps,progress:this.progress,lapLength:this.lapLength,speed:Math.round(this.speed),lane:this.lane,collisions:this.collisions,lapTimes:[...this.lapTimes],obstacles:this.obstacles};}
}
