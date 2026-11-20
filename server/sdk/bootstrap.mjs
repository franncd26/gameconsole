import { discoverPlugins, GameRegistry } from './registry.mjs';
import { GamePluginLoader } from './loader.mjs';
import { GameSessionFactory } from './session-factory.mjs';
import { GameInstanceManager } from './instance-manager.mjs';
import { OutboxEventSink } from './outbox-event-sink.mjs';
import { requireSDK, SDKError } from './values.mjs';

class PreparedSDK {
  #registry; #loader; #importer;
  #factory;
  #catalog;
  #trusted;
  #webPackages;
  constructor(factory, catalog, ids, packages, registry, loader) {
    this.#registry = registry; this.#loader = loader;
    this.#factory = factory;
    this.#catalog = catalog;
    this.#trusted = new Set(ids);
    this.#webPackages = new Map(packages.map((p) => [p.manifest.id, p]));
    Object.freeze(this);
  }
  enableImporter(importer) { this.#importer = importer; }
  has(id) { return Boolean(this.#registry.get(id)); }
  recoveryPackage() { return structuredClone([...this.#webPackages.values()].find(p => p.paths.profile)); }
  async validatePackage(directory) {
    const registry = new GameRegistry(), record = await registry.register(directory);
    requireSDK(!this.has(record.manifest.id), 'DUPLICATE_ID', 'El ID ya está registrado.');
    const loader = new GamePluginLoader(registry, { trustedIds: [record.manifest.id] });
    const executable = await loader.load(record.manifest.id);
    const probe = await new GameSessionFactory(loader).prepare(record.manifest.id);
    try { requireSDK(probe.hasCoordinatedState, 'INVALID_SESSION_INTERFACE', 'El paquete importado requiere una celda createState para dispatch público.'); }
    finally { await probe.dispose('installation_validation'); } // No manager, start event or session quota.
    return { record, executable };
  }
  async publishPackage(candidate) {
    const p = await this.#registry.register(candidate.record.directory, { expected: candidate.record });
    this.#loader.trustRegistered(p.manifest.id, candidate.executable);
    this.#trusted.add(p.manifest.id); this.#webPackages.set(p.manifest.id, p);
  }
  connect(outbox) {
    const manager = new GameInstanceManager(this.#factory, { eventSink: new OutboxEventSink(outbox) });
    return Object.freeze({
      manager,
      catalog: () => this.#registry.publicCatalog().filter(m => this.#trusted.has(m.id)),
      importer: this.#importer,
      isTrusted: (id) => this.#trusted.has(id),
      // Host-only metadata, never part of publicCatalog or any JSON response.
      webPackage: (id) => this.#trusted.has(id) ? structuredClone(this.#webPackages.get(id)) : undefined,
      async shutdown() {
        let sessions;
        try { sessions = await manager.list(); }
        catch {
          const error = new SDKError('SDK_SHUTDOWN_FAILED', 'No se pudieron enumerar las sesiones para el apagado.');
          error.failures = [{ code: 'SDK_ENUMERATION_FAILED' }];
          throw error;
        }
        const settled = await Promise.allSettled(sessions.map((s) =>
          Promise.resolve().then(() => manager.finish(s.matchId, { reason: 'shutdown' }))));
        const failures = settled.flatMap((result, index) => {
          if (result.status === 'fulfilled') return [];
          const code = ['CLEANUP_FAILED', 'EVENT_ACCEPTANCE_FAILED', 'EVENT_SINK_UNAVAILABLE',
            'INVALID_SNAPSHOT', 'VERSION_LIMIT', 'UNKNOWN_MATCH', 'INVALID_LIFECYCLE'].includes(result.reason?.code)
            ? result.reason.code : 'SDK_CLOSE_FAILED';
          return [{ matchId: sessions[index].matchId, code }];
        });
        if (failures.length) {
          const error = new SDKError('SDK_SHUTDOWN_FAILED', 'Uno o más cierres SDK fallaron; todos los cierres iniciados han terminado.');
          error.failures = failures; // Internal diagnostics only; never retain raw plugin errors/causes.
          throw error;
        }
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
    registry.publicCatalog().filter((m) => trustedIds.includes(m.id)), trustedIds,
    trustedIds.map((id) => registry.get(id)), registry, loader);
}

export function connectSDK(prepared, outbox) {
  if (prepared === undefined) return undefined;
  requireSDK(prepared instanceof PreparedSDK, 'SDK_CONFIGURATION', 'Se requiere bootstrap SDK preparado.');
  return prepared.connect(outbox);
}

export async function prepareSDKFromEnvironment(env = process.env) {
  requireSDK(['0', '1'].includes(env.GAMECONSOLE_IMPORT_ENABLED ?? '0'), 'SDK_CONFIGURATION', 'Flag de importación inválido.');
  const enabled = env.GAMECONSOLE_SDK_ENABLED ?? '0';
  requireSDK(['0', '1'].includes(enabled), 'SDK_CONFIGURATION', 'GAMECONSOLE_SDK_ENABLED debe ser 0 o 1.');
  if (enabled === '0') {
    requireSDK(!env.GAMECONSOLE_PLUGINS_DIR && !env.GAMECONSOLE_TRUSTED_IDS && env.GAMECONSOLE_IMPORT_ENABLED !== '1',
      'SDK_CONFIGURATION', 'La configuración de plugins requiere habilitar explícitamente el SDK.');
    return undefined;
  }
  const prepared = await prepareSDK({ pluginsDirectory: env.GAMECONSOLE_PLUGINS_DIR,
    trustedIds: env.GAMECONSOLE_TRUSTED_IDS?.split(',').map((id) => id.trim()) });
  if (env.GAMECONSOLE_IMPORT_ENABLED === '1') {
    const { PluginImporter } = await import('./importer/service.mjs');
    const importer = new PluginImporter(prepared, { storage: env.GAMECONSOLE_IMPORT_DIR,
      profiles: env.GAMECONSOLE_IMPORT_PROFILES_DIR, scalaURL: env.GAMECONSOLE_IMPORT_SCALA_URL, stateDirectory: env.GAMECONSOLE_IMPORT_STATE_DIR });
    await importer.initialize(); prepared.enableImporter(importer);
  }
  return prepared;
}
