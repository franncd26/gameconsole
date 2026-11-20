import { fileURLToPath } from 'node:url';
import { prepareSDK } from '../server/sdk/bootstrap.mjs';
import { createApp, shutdownApp } from '../server/index.mjs';

// Bounded local demo only: no real Go/Scala/Prolog, no automatic game actions.
const sdk = await prepareSDK({ pluginsDirectory: fileURLToPath(new URL('../plugins/', import.meta.url)), trustedIds: ['tic-tac-toe', 'snake', 'racing'] });
const app = createApp({ sdk, statsURL: 'http://mock.invalid', statsFetcher: async (url) => {
  if (new URL(url).pathname !== '/events') throw Error('Esta demo solo simula aceptación de eventos.');
  return new Response('{}', { status: 201 });
} });
let stopping;
const stop = () => stopping ??= (async () => {
  await shutdownApp(app); app.server.closeAllConnections(); await new Promise((resolve) => app.server.close(resolve));
  clearTimeout(deadline); console.log('Bridge demo cerrada.');
})();
const deadline = setTimeout(() => { void stop(); }, 300000);
app.server.on('request', (req, res) => {
  if (req.method === 'GET' && req.url === '/api/health?bridge-demo-stop=1') res.once('finish', () => { void stop(); });
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(); });
await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
console.log(`Bridge demo (Go simulado, máximo 5 minutos): http://127.0.0.1:${app.server.address().port}/sdk/bridge-demo.html`);
