import { discoverPlugins } from './registry.mjs';
import { GamePluginLoader } from './loader.mjs';
import { GameSessionFactory } from './session-factory.mjs';
import { GameInstanceManager } from './instance-manager.mjs';
import { OutboxEventSink } from './outbox-event-sink.mjs';
import { requireSDK, SDKError } from './values.mjs';

class PreparedSDK {
  #factory;
  #catalog;
  #trusted;
  constructor(factory, catalog, ids) {
    this.#factory = factory;
    this.#catalog = catalog;
    this.#trusted = new Set(ids);
    Object.freeze(this);
  }
  connect(outbox) {
    const manager = new GameInstanceManager(this.#factory, { eventSink: new OutboxEventSink(outbox) });
    return Object.freeze({
      manager,
      catalog: () => structuredClone(this.#catalog),
      isTrusted: (id) => this.#trusted.has(id),
      async shutdown() {
        await Promise.all((await manager.list()).map((s) => manager.finish(s.matchId, { reason: 'shutdown' })));
      },
    });
  }
}

/** Host-only bootstrap. Discovery never imports modules; only explicitly trusted IDs load afterward. */
export async function prepareSDK({ pluginsDirectory, trustedIds } = {}) {
  requireSDK(typeof pluginsDirectory === 'string' && pluginsDirectory.trim()
    && Array.isArray(trustedIds) && trustedIds.length > 0
    && trustedIds.every((id) => typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length <= 64)
    && new Set(trustedIds).size === trustedIds.length,
  'SDK_CONFIGURATION', 'Se requieren directorio y lista explícita de IDs confiables únicos.');
  const { registry, errors } = await discoverPlugins(pluginsDirectory);
  requireSDK(errors.length === 0, 'SDK_DISCOVERY_FAILED', 'Hay paquetes inválidos o IDs en conflicto; se cancela el bootstrap.');
  requireSDK(trustedIds.every((id) => registry.get(id)), 'SDK_TRUSTED_MISSING', 'Falta un plugin requerido como confiable.');
  const loader = new GamePluginLoader(registry, { trustedIds });
  try { for (const id of trustedIds) await loader.load(id); }
  catch { throw new SDKError('SDK_PLUGIN_FAILED', 'No se pudo cargar la interfaz de un plugin confiable.'); }
  return new PreparedSDK(new GameSessionFactory(loader),
    registry.publicCatalog().filter((m) => trustedIds.includes(m.id)), trustedIds);
}

export function connectSDK(prepared, outbox) {
  if (prepared === undefined) return undefined;
  requireSDK(prepared instanceof PreparedSDK, 'SDK_CONFIGURATION', 'Se requiere bootstrap SDK preparado.');
  return prepared.connect(outbox);
}

export async function prepareSDKFromEnvironment(env = process.env) {
  const enabled = env.GAMECONSOLE_SDK_ENABLED ?? '0';
  requireSDK(['0', '1'].includes(enabled), 'SDK_CONFIGURATION', 'GAMECONSOLE_SDK_ENABLED debe ser 0 o 1.');
  if (enabled === '0') {
    requireSDK(!env.GAMECONSOLE_PLUGINS_DIR && !env.GAMECONSOLE_TRUSTED_IDS,
      'SDK_CONFIGURATION', 'La configuración de plugins requiere habilitar explícitamente el SDK.');
    return undefined;
  }
  return prepareSDK({ pluginsDirectory: env.GAMECONSOLE_PLUGINS_DIR,
    trustedIds: env.GAMECONSOLE_TRUSTED_IDS?.split(',').map((id) => id.trim()) });
}
