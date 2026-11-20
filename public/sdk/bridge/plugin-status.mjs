import { createGameBridgeClient } from './game-client.mjs';

const field = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = String(value); };
const bridge = createGameBridgeClient();
bridge.onInit(({ gameId, matchId }) => { field('bridge-state', 'Conectado · Bridge v1'); field('game-id', gameId); field('match-id', matchId); });
bridge.onSnapshot((snapshot) => { field('match-state', snapshot.state); field('match-version', snapshot.version); });
bridge.onError(({ code }) => field('bridge-state', `Error: ${code}`));
bridge.onDetach(() => field('bridge-state', 'Desconectado'));
window.addEventListener('pagehide', () => bridge.dispose(), { once: true });
