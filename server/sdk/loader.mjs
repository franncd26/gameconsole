import { pathToFileURL } from 'node:url';
import { GameRegistry } from './registry.mjs';
import { loadManifest } from './manifest.mjs';
import { validateInitializationContract } from './initialization.mjs';
import { freezeJSON, isObject, requireSDK, SDKError } from './values.mjs';

/** An executable cache, not a second catalog. Trust is configured by host code. */
export class GamePluginLoader {
  #registry;
  #trustedIds;
  #modules = new Map();

  constructor(registry, { trustedIds = [] } = {}) {
    requireSDK(registry instanceof GameRegistry && Array.isArray(trustedIds)
      && trustedIds.every((id) => typeof id === 'string'), 'INVALID_CONFIGURATION', 'Se requiere registro y lista explícita de IDs confiables.');
    this.#registry = registry;
    this.#trustedIds = new Set(trustedIds);
  }

  async load(gameId) {
    const registered = this.#registry.get(gameId);
    requireSDK(registered, 'UNKNOWN_PLUGIN', 'El plugin no está registrado.');
    requireSDK(this.#trustedIds.has(gameId), 'UNTRUSTED_PLUGIN', 'El host no autorizó ejecutar este plugin.');
    if (!this.#modules.has(gameId)) this.#modules.set(gameId, this.#load(registered));
    return this.#modules.get(gameId);
  }
  // Host-only publication of an executable already checked by an isolated SDK loader.
  trustRegistered(gameId, executable) {
    const registered = this.#registry.get(gameId);
    requireSDK(registered && JSON.stringify(registered.manifest) === JSON.stringify(executable.manifest)
      && !this.#trustedIds.has(gameId), 'INVALID_CONFIGURATION', 'Publicación de plugin incompatible.');
    this.#trustedIds.add(gameId); this.#modules.set(gameId, Promise.resolve(executable));
  }

  async #load(registered) {
    let current;
    try {
      current = await loadManifest(registered.directory);
    } catch {
      throw new SDKError('PLUGIN_CHANGED', 'El paquete registrado ya no es válido; requiere revisión y nuevo registro.');
    }
    requireSDK(JSON.stringify(current) === JSON.stringify(registered), 'PLUGIN_CHANGED', 'El paquete cambió después de registrarse.');
    let namespace;
    try {
      namespace = await import(pathToFileURL(current.paths.server).href);
    } catch {
      throw new SDKError('PLUGIN_LOAD_FAILED', 'No se pudo importar el módulo confiable.');
    }
    const plugin = namespace.default;
    requireSDK(isObject(plugin) && typeof plugin.createSession === 'function',
      'INVALID_PLUGIN_INTERFACE', 'Se requiere default GamePlugin con createSession.');
    const initializationContract = validateInitializationContract(plugin.initializationContract, current.manifest);
    return Object.freeze({
      manifest: freezeJSON(current.manifest), initializationContract,
      createSession: plugin.createSession.bind(plugin),
    });
  }
}
