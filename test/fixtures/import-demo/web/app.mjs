import { createGameBridgeClient } from '/sdk/bridge/game-client.mjs';
const bridge = createGameBridgeClient(), status = document.getElementById('status');
const buttons = ['increment','complete'].map(id => document.getElementById(id));
let busy = false, control = true, uncertain = false;
function render() {
  const s = bridge.getSnapshot(); document.getElementById('count').textContent = s ? String(s.data.count) : '—';
  buttons.forEach(b => { b.disabled = busy || !control || uncertain || s?.state !== 'running'; });
}
bridge.onInit(() => { status.textContent = 'Listo'; render(); }); bridge.onSnapshot(render);
bridge.onPresentation(p => { control = p.canControl; render(); });
bridge.onDetach(() => { control = false; render(); });
async function action(type) {
  if (busy || !control || uncertain) return; busy = true; render();
  try { const result = await bridge.dispatch(type, {}); status.textContent = result.outcome; await bridge.requestSnapshot(); }
  catch (e) { uncertain = Boolean(e.unknown); status.textContent = 'No se confirmó la operación. Consulta la partida desde la consola.'; }
  finally { busy = false; render(); }
}
buttons[0].addEventListener('click', () => void action('INCREMENT')); buttons[1].addEventListener('click', () => void action('COMPLETE'));
window.addEventListener('pagehide', () => bridge.dispose(), { once: true });
