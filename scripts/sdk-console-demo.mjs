import { fileURLToPath } from 'node:url';
import { prepareSDK } from '../server/sdk/bootstrap.mjs';
import { createApp, shutdownApp } from '../server/index.mjs';
import { analysisDouble } from '../test/fixtures/sdk-console/analysis-double.mjs';

// Bounded local development demo. The production console contains no simulated statistics.
const ids = ['tic-tac-toe', 'snake', 'racing'];
const sdk = await prepareSDK({ pluginsDirectory: fileURLToPath(new URL('../plugins/', import.meta.url)), trustedIds: ids });
const app = createApp({ sdk, statsURL: 'http://mock.invalid', statsFetcher: analysisDouble(ids).fetcher });
let stopping;
const stop = () => stopping ??= (async () => {
  await shutdownApp(app); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
  clearTimeout(deadline); console.log('Demo de consola cerrada.');
})();
const deadline = setTimeout(() => void stop(), 300000);
app.server.on('request', (req, res) => {
  if (req.method === 'GET' && req.url === '/api/health?console-demo-stop=1') res.once('finish', () => void stop());
});
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => void stop());
await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
console.log('Demo consola (estadísticas SIMULADAS, máximo 5 minutos): http://127.0.0.1:' + app.server.address().port + '/');
console.log('No pulses Gato sin SWI-Prolog disponible. La demo no inicia servicios externos.');
