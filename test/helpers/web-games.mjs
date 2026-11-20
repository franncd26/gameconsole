import { GatoController } from '../../plugins/tic-tac-toe/web/controller.mjs';
import { GatoView } from '../../plugins/tic-tac-toe/web/view.mjs';
import { SnakeController } from '../../plugins/snake/web/controller.mjs';
import { SnakeView } from '../../plugins/snake/web/view.mjs';
import { RacingController } from '../../plugins/racing/web/controller.mjs';
import { RacingView } from '../../plugins/racing/web/view.mjs';

export const copy = (value) => structuredClone(value);
export const settle = async () => { for (let i=0;i<20;i++) await Promise.resolve(); };
export function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
export class Target {
  constructor(){this.listeners=new Map();}
  addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
  removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
  fire(type,extra={}){const e={key:'',preventDefault(){},...extra};for(const fn of this.listeners.get(type)||[])fn(e);}
  get listenerCount(){return [...this.listeners.values()].reduce((n,s)=>n+s.size,0);}
}
class Element extends Target {
  constructor(dataset={}){super();this.dataset=dataset;this.textContent='';this.disabled=false;this.hidden=false;this.attributes={};this.classes=new Set();this.classList={toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)};this.width=300;this.height=240;this.draws=[];
    this.context=new Proxy({}, {get:(_,key)=>(...args)=>this.draws.push([key,...args]),set:()=>true});}
  setAttribute(name,value){this.attributes[name]=value;}
  getContext(){return this.context;}
}
export class Document extends Target {
  constructor(game){super();this.hidden=false;this.nodes=new Map();for(const id of ['connection','note','result','identity','sync','replay','track','difficulty','turn','turn-label','points','size','speed','laps','collisions','times'])this.nodes.set(id,new Element());
    if(game==='tic-tac-toe'){this.nodes.set('retry-ai',new Element());this.cells=Array.from({length:9},(_,i)=>new Element({cell:String(i)}));}
    else {this.nodes.set('start',new Element());this.nodes.set('canvas',new Element());}
    this.directions=game==='snake'?['up','left','down','right'].map(direction=>new Element({direction})):[];
    this.lanes=game==='racing'?[-1,1].map(lane=>new Element({lane:String(lane)})):[];
    this.pedals=game==='racing'?['accelerate','brake'].map(pedal=>new Element({pedal})):[];
  }
  getElementById(id){return this.nodes.get(id)||null;}
  querySelectorAll(selector){return selector==='[data-cell]'?this.cells:selector==='[data-direction]'?this.directions:selector==='[data-lane]'?this.lanes:selector==='[data-pedal]'?this.pedals:[...this.lanes,...this.pedals];}
}
export class Clock {
  constructor(){this.next=0;this.jobs=new Map();}
  setTimeout(fn,delay){const id=++this.next;this.jobs.set(id,{fn,delay});return id;}
  clearTimeout(id){this.jobs.delete(id);}
  async step(){const job=this.jobs.entries().next().value;if(job){this.jobs.delete(job[0]);job[1].fn();}await settle();}
}
export function snapshot(game='snake',changes={}) {
  const data=game==='tic-tac-toe'?{board:Array(9).fill(''),turn:0,difficulty:'hard',winningLine:[],lastDecision:null,result:null,awaitingAI:false}:game==='snake'?{size:20,body:[{x:6,y:10},{x:5,y:10},{x:4,y:10}],direction:'right',food:{x:15,y:10},points:0,result:null}:{lap:0,totalLaps:3,progress:0,lapLength:1200,speed:0,lane:1,collisions:0,lapTimes:[],obstacles:[{position:240,lane:1}],hit:[],lastTick:100,lapStarted:100,result:null};
  return {gameId:game,matchId:'match-'+game,state:'running',version:0,data,...copy(changes)};
}
export class Bridge {
  constructor(s){this.snapshot=copy(s);this.callbacks=new Map();this.calls=[];this.reads=0;this.disposed=false;this.handler=async()=>({outcome:'completed',committed:false,confirmations:0,snapshot:copy(this.snapshot)});}
  sub(type,fn){if(!this.callbacks.has(type))this.callbacks.set(type,new Set());this.callbacks.get(type).add(fn);return()=>this.callbacks.get(type).delete(fn);}
  onInit(fn){return this.sub('init',fn);} onSnapshot(fn){return this.sub('snapshot',fn);} onResult(fn){return this.sub('result',fn);} onError(fn){return this.sub('error',fn);} onDetach(fn){return this.sub('detach',fn);}
  emit(type,value){for(const fn of this.callbacks.get(type)||[])fn(copy(value));}
  init(){this.emit('init',{gameId:this.snapshot.gameId,matchId:this.snapshot.matchId,options:{},snapshot:this.snapshot});}
  publish(s){this.snapshot=copy(s);this.emit('snapshot',s);}
  getSnapshot(){return copy(this.snapshot);}
  async requestSnapshot(){this.reads++;if(this.readFailure)throw this.readFailure;return copy(this.snapshot);}
  async dispatch(type,payload,options){this.calls.push(copy({type,payload,...options}));const r=await this.handler(type,payload,options);this.emit('result',r);return copy(r);}
  dispose(){this.disposed=true;this.callbacks.clear();}
}
export function setup(game,changes={}) {
  const doc=new Document(game),window=new Target(),clock=new Clock(),bridge=new Bridge(snapshot(game,changes));let ids=0;
  const [Controller,View]=game==='tic-tac-toe'?[GatoController,GatoView]:game==='snake'?[SnakeController,SnakeView]:[RacingController,RacingView];
  const view=new View(doc),controller=new Controller({bridge,view,window,document:doc,clock,id:()=>game+'-'+(++ids)});bridge.init();
  return {doc,window,clock,bridge,view,controller,node:id=>doc.getElementById(id)};
}
