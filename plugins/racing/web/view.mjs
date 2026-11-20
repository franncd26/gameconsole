export class RacingView {

  constructor(document) {
    this.document=document; this.listeners=[]; this.previousCollisions=0; this.retryAI=document.getElementById('retry-ai');
    for(const id of ['connection','note','result','identity','sync','replay','start']) this[id]=document.getElementById(id);
    this.canvas=document.getElementById('canvas');this.context=this.canvas?.getContext('2d');
  }
  listen(node,type,callback){node.addEventListener(type,callback);this.listeners.push(()=>node.removeEventListener(type,callback));}
  commonBind(actions){this.listen(this.sync,'click',actions.sync);this.listen(this.replay,'click',actions.replay);if(this.start)this.listen(this.start,'click',actions.start);}
  commonRender(model){
    const labels={ready:'Preparado',playing:'Jugando',manuallyPaused:'Pausado',autoSuspended:'En segundo plano',spectator:'Observador',resyncing:'Sincronizando',uncertain:'Resultado sin confirmar',finished:'Finalizado'};
    this.connection.textContent=model.connected?(labels[model.presentationState]||'Conectado'):'Sin conexión';
    this.note.textContent=model.note;this.sync.disabled=!model.connected||model.busy;
    this.replay.hidden=!model.uncertain;this.replay.disabled=model.busy||!model.connected||!model.canControl||model.snapshot?.state!=='running';
    if(this.start){
      this.start.disabled=!model.connected||model.busy||model.uncertain||!model.active||model.snapshot?.state!=='running';
      this.start.textContent=model.busy?'Esperando sincronización':model.armed?'Pausa':model.presentationState==='ready'?'Jugar':'Continuar';
    }
    const s=model.snapshot;this.identity.textContent=s?s.gameId+' · '+s.matchId+' · '+s.state+' · v'+s.version:'Esperando INIT';
  }
  dispose(){for(const remove of this.listeners)remove();this.listeners=[];}

  bind(actions){
    this.commonBind(actions);
    for(const b of this.document.querySelectorAll('[data-lane]'))this.listen(b,'click',()=>actions.lane(Number(b.dataset.lane)));
    for(const b of this.document.querySelectorAll('[data-pedal]')){
      const set=pressed=>actions.pedal(b.dataset.pedal,pressed);
      this.listen(b,'pointerdown',e=>{if(b.disabled)return;b.setPointerCapture?.(e.pointerId);set(true);});
      for(const type of ['pointerup','pointercancel','lostpointercapture'])this.listen(b,type,()=>set(false));
      this.listen(b,'keydown',e=>{if([' ','Enter'].includes(e.key)){e.preventDefault();set(true);}});
      this.listen(b,'keyup',e=>{if([' ','Enter'].includes(e.key)){e.preventDefault();set(false);}});
      this.listen(b,'blur',()=>set(false));
    }
  }
  render(model){
    this.commonRender(model);const s=model.snapshot,data=s?.data;
    this.document.getElementById('speed').textContent=String(Math.round(data?.speed??0));
    this.document.getElementById('laps').textContent=(data?.lap??0)+' / '+(data?.totalLaps??3);
    this.document.getElementById('collisions').textContent=String(data?.collisions??0);
    this.document.getElementById('times').textContent=data?.lapTimes.length?data.lapTimes.map((t,i)=>(i+1)+': '+(t/1000).toFixed(2)+' s').join(' · '):'Sin vueltas completadas';
    this.result.textContent=data?.result==='race_completed'?'¡Carrera completada!':s&&s.state!=='running'?'Partida cerrada':'';
    if(data&&data.collisions>this.previousCollisions)this.collisionVersion=s.version;
    this.document.getElementById('track').classList.toggle('flash',Boolean(data&&s.version===this.collisionVersion));this.previousCollisions=data?.collisions??0;
    for(const b of this.document.querySelectorAll('[data-lane], [data-pedal]')){
      b.disabled=!model.connected||!model.active||model.uncertain||s?.state!=='running';
      if(b.dataset.pedal){b.classList.toggle('held',model[b.dataset.pedal]);b.setAttribute('aria-pressed',String(model[b.dataset.pedal]));}
    }
    const c=this.context;if(!c)return;const w=this.canvas.width,h=this.canvas.height,lw=w/3;
    c.fillStyle='#171e30';c.fillRect(0,0,w,h);c.strokeStyle='#69758c';c.lineWidth=2;c.setLineDash([12,12]);
    for(let i=1;i<3;i++){c.beginPath();c.moveTo(i*lw,0);c.lineTo(i*lw,h);c.stroke();}c.setLineDash([]);if(!data)return;
    const y=h-42;
    data.obstacles.forEach((o,i)=>{const distance=o.position-data.progress;if(distance< -30||distance>420)return;c.fillStyle=data.hit.includes(i)?'#66514b':'#ff946b';c.fillRect(o.lane*lw+lw*.3,y-distance/420*(h-55),lw*.4,15);});
    c.fillStyle='#83e4ff';c.fillRect(data.lane*lw+lw*.3,y,lw*.4,30);
    c.fillStyle='#e5fbff';c.fillRect(data.lane*lw+lw*.36,y+5,lw*.28,7);
  }

}

