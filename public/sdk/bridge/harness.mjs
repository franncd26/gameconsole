import { HostBridge } from './host-bridge.mjs';

const status = document.getElementById('status'), events = document.getElementById('events');
const bridge = new HostBridge({ onStatus: (event) => {
  if (event.state === 'initialized') status.textContent = `Bridge conectado: ${event.gameId} · ${event.matchId}`;
  if (event.state === 'error') status.textContent = `Bridge: ${event.code}`;
  events.textContent = `${event.state} ${event.gameId} ${event.matchId}${event.code ? ` ${event.code}` : ''}\n${events.textContent}`.slice(0, 8000);
} });
async function api(route, body) {
  const r = await fetch('/api/sdk/' + route, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw Error(`HTTP ${r.status}: operación SDK no disponible.`);
  return r.json();
}
try {
  const catalog = await api('catalog');
  for (const item of catalog) {
    const option = document.createElement('option'); option.value = item.id; option.textContent = item.name;
    document.getElementById('catalog').append(option);
  }
  status.textContent = 'Catálogo confiable disponible. Se aplicarán las opciones predeterminadas.';
} catch { status.textContent = 'SDK no disponible. Habilitar el bootstrap y la lista explícita de plugins confiables.'; }
document.getElementById('create').addEventListener('click', async () => {
  try {
    let snapshot = await api('matches', { gameId: document.getElementById('catalog').value });
    const section = document.createElement('section'), title = document.createElement('h2'), container = document.createElement('div');
    title.textContent = `${snapshot.gameId} · ${snapshot.matchId}`; section.append(title);
    let frame;
    const button = (label, work) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      b.addEventListener('click', () => { void work().catch(() => { status.textContent = 'Operación no completada; consultar snapshot antes de continuar.'; }); });
      section.append(b);
    };
    button('Snapshot', async () => { snapshot = await api(`matches/${snapshot.matchId}`); status.textContent = `${snapshot.state} · versión ${snapshot.version}`; });
    button('Desmontar', async () => { if (frame) bridge.unmount(frame); frame = null; });
    button('Montar de nuevo', async () => {
      if (frame) bridge.unmount(frame);
      snapshot = await api(`matches/${snapshot.matchId}`); frame = bridge.mount(container, snapshot);
    });
    button('Finalizar partida', async () => {
      snapshot = await api(`matches/${snapshot.matchId}/finish`, { reason: 'bridge_demo_completed' });
      status.textContent = `${snapshot.gameId}: ${snapshot.state}`;
      if (frame) { bridge.unmount(frame); frame = bridge.mount(container, snapshot); }
    });
    section.append(container); document.getElementById('matches').append(section);
    frame = bridge.mount(container, snapshot); status.textContent = 'Iframe montado; esperando READY e INIT.';
  } catch { status.textContent = 'No se pudo crear. Revisar SDK y límite de una partida activa por tipo.'; }
});
window.addEventListener('pagehide', () => bridge.dispose(), { once: true });
