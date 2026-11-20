export class SnakeView {

  constructor(document) {
    this.document=document; this.listeners=[]; this.previousCollisions=0; this.retryAI=document.getElementById('retry-ai');
    for(const id of ['connection','note','result','identity','sync','replay','start']) this[id]=document.getElementById(id);
    this.canvas=document.getElementById('canvas');this.context=this.canvas?.getContext('2d');
  }
  listen(node,type,callback){node.addEventListener(type,callback);this.listeners.push(()=>node.removeEventListener(type,callback));}
  commonBind(actions){this.listen(this.sync,'click',actions.sync);this.listen(this.replay,'click',actions.replay);if(this.start)this.listen(this.start,'click',actions.start);}
  commonRender(model){
    this.connection.textContent=model.connected?(model.busy?'Enviando…':'Bridge conectado'):'Sin conexión';
    this.note.textContent=model.note;this.sync.disabled=!model.connected||model.busy;
    this.replay.hidden=!model.uncertain;this.replay.disabled=model.busy||!model.connected||model.snapshot?.state!=='running';
    if(this.start)this.start.disabled=!model.connected||model.busy||model.uncertain||model.snapshot?.state!=='running'||model.armed;
    const s=model.snapshot;this.identity.textContent=s?s.gameId+' · '+s.matchId+' · '+s.state+' · v'+s.version:'Esperando INIT';
  }
  dispose(){for(const remove of this.listeners)remove();this.listeners=[];}

  bind(actions){this.commonBind(actions);for(const b of this.document.querySelectorAll('[data-direction]'))this.listen(b,'click',()=>actions.direction(b.dataset.direction));}
  render(model){
    this.commonRender(model);const s=model.snapshot,data=s?.data;
    this.document.getElementById('points').textContent=String(data?.points??0);
    this.document.getElementById('size').textContent=data?data.size+' × '+data.size:'—';
    this.result.textContent=({game_over:'Fin de partida',board_completed:'¡Tablero completado!'})[data?.result]||(s&&s.state!=='running'?'Partida cerrada':'');
    for(const b of this.document.querySelectorAll('[data-direction]'))b.disabled=!model.connected||model.uncertain||s?.state!=='running';
    const c=this.context;if(!c)return;const w=this.canvas.width;c.fillStyle='#0c1720';c.fillRect(0,0,w,w);if(!data)return;
    const step=w/data.size;c.strokeStyle='#1b303c';c.lineWidth=.5;
    for(let i=0;i<=data.size;i++){c.beginPath();c.moveTo(i*step,0);c.lineTo(i*step,w);c.stroke();c.beginPath();c.moveTo(0,i*step);c.lineTo(w,i*step);c.stroke();}
    if(data.food){c.fillStyle='#ff7185';c.beginPath();c.arc((data.food.x+.5)*step,(data.food.y+.5)*step,step*.32,0,Math.PI*2);c.fill();}
    data.body.forEach((p,i)=>{c.fillStyle=i===0?'#edffbb':'#91d55b';c.fillRect(p.x*step+1,p.y*step+1,step-2,step-2);});
  }

}

