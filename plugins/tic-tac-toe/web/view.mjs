export class GatoView {

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

  bind(actions){
    this.commonBind(actions);this.cells=[...this.document.querySelectorAll('[data-cell]')];
    this.cells.forEach((cell,index)=>this.listen(cell,'click',()=>actions.mark(index)));
    this.retryAI=this.document.getElementById('retry-ai');this.listen(this.retryAI,'click',actions.retryAI);
  }
  render(model){
    this.commonRender(model);const s=model.snapshot,data=s?.data;
    const disabled=!model.connected||model.busy||model.uncertain||model.needsSync||!model.active||s?.state!=='running';
    for(const[index,cell]of(this.cells||[]).entries()){
      const symbol=data?.board[index]||'';cell.textContent=symbol;
      cell.setAttribute('aria-label','Casilla '+(index+1)+': '+(symbol||'vacía'));
      cell.disabled=disabled||!data||Boolean(symbol)||data.awaitingAI||Boolean(data.result);
      cell.classList.toggle('winner',Boolean(data?.winningLine.includes(index)));cell.classList.toggle('opponent',symbol==='O');
    }
    this.retryAI.hidden=!data?.awaitingAI||s?.state!=='running';this.retryAI.disabled=disabled;
    this.document.getElementById('difficulty').textContent=data?({easy:'Básica',medium:'Táctica',hard:'Minimax'}[data.difficulty]):'—';
    this.document.getElementById('turn').textContent=String(data?.turn??0);
    this.document.getElementById('turn-label').textContent=!data?'Preparando tablero':data.result?'Partida terminada':data.awaitingAI?'Prolog tiene una decisión pendiente':model.busy?'Consultando a Prolog…':'Tu turno · X';
    this.result.textContent=({human_won:'¡Ganaste!',prolog_won:'Prolog gana',draw:'Empate'})[data?.result]||(s&&s.state!=='running'?'Partida cerrada por la consola':'');
  }

}

