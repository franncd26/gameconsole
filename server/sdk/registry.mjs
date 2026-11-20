import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, ManifestError } from './manifest.mjs';

export const DEFAULT_PLUGINS_DIRECTORY = fileURLToPath(new URL('../../plugins/', import.meta.url));

/** Metadata only. Every value crossing the API boundary is a defensive copy. */
export class GameRegistry {
  #plugins = new Map();

  async register(pluginDirectory, { expected } = {}) {
    const plugin = await loadManifest(pluginDirectory);
    if (expected && JSON.stringify(expected) !== JSON.stringify(plugin)) throw new ManifestError('PLUGIN_CHANGED', 'plugin', 'el paquete cambió antes de publicarse');
    const id = plugin.manifest.id;
    if (this.#plugins.has(id)) {
      throw new ManifestError('DUPLICATE_ID', 'id', 'ID ya registrado; se conserva el primer paquete válido');
    }
    this.#plugins.set(id, plugin);
    return structuredClone(plugin);
  }

  get(id) {
    const plugin = this.#plugins.get(id);
    return plugin ? structuredClone(plugin) : undefined;
  }

  list() {
    return [...this.#plugins.keys()].sort().map((id) => this.get(id));
  }

  publicCatalog() {
    return this.list().map(({ manifest: m }) => ({
      id: m.id, name: m.name, version: m.version, description: m.description,
      category: m.category, capabilities: m.capabilities, players: m.players,
      options: m.options,
    }));
  }
}

function rejection(candidate, error) {
  return error instanceof ManifestError
    ? { candidate, code: error.code, field: error.field, message: error.message }
    : { candidate, code: 'DISCOVERY_IO', field: 'plugins', message: 'plugins: no se pudo inspeccionar el directorio' };
}

/** Immediate subdirectories only, sorted by JS code-unit order, independent of locale. */
export async function discoverPlugins(pluginsDirectory = DEFAULT_PLUGINS_DIRECTORY) {
  const registry = new GameRegistry();
  const errors = [];
  let directory;
  let entries;
  try {
    directory = await realpath(pluginsDirectory);
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') errors.push(rejection(null, error));
    return { registry, errors };
  }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const [index, entry] of entries.entries()) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidate = /^[a-zA-Z0-9_-]{1,80}$/.test(entry.name) ? entry.name : `candidate-${index + 1}`;
    try {
      if (entry.isSymbolicLink()) {
        throw new ManifestError('UNSAFE_PATH', 'plugin', 'no se admiten candidatos enlazados simbólicamente');
      }
      await registry.register(path.join(directory, entry.name));
    } catch (error) {
      errors.push(rejection(candidate, error));
    }
  }
  return { registry, errors };
}
