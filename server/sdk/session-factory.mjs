import { randomUUID } from 'node:crypto';
import { GamePluginLoader } from './loader.mjs';
import { validateOptions } from './options.mjs';
import { validatePlayers, validateStartData } from './initialization.mjs';
import { copyJSON, isObject, requireSDK, SDKError } from './values.mjs';

const quietLogger = Object.freeze(Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, () => {}])));

/** Internal preparation API. The returned handle belongs to the host manager. */
export class GameSessionFactory {
  #loader;
  #sessions = new WeakSet();

  constructor(loader) {
    requireSDK(loader instanceof GamePluginLoader, 'INVALID_CONFIGURATION', 'Se requiere GamePluginLoader.');
    this.#loader = loader;
  }

  async prepare(gameId, configuration = {}) {
    const config = copyJSON(configuration, 'INVALID_CONFIGURATION');
    requireSDK(isObject(config) && Object.keys(config).every((key) => ['options', 'players'].includes(key)),
      'INVALID_CONFIGURATION', 'La preparación solo admite options y players.');
    const executable = await this.#loader.load(gameId);
    const { manifest, initializationContract } = executable;
    const options = validateOptions(manifest, config.options);
    const players = validatePlayers(initializationContract, manifest, config.players);
    const matchId = randomUUID();
    const controller = new AbortController();
    let phase = 'preparing';
    let forbiddenAttempt = false;
    const unavailable = () => {
      if (phase === 'preparing') forbiddenAttempt = true;
      throw new SDKError(phase === 'preparing' ? 'EVENT_DURING_PREPARATION' : 'EVENTS_UNAVAILABLE',
        'Eventos y solicitudes de cierre no están habilitados en Fase 2A.');
    };
    const context = Object.freeze({
      gameId: manifest.id, gameVersion: manifest.version, matchId, players,
      logger: quietLogger, signal: controller.signal, services: Object.freeze({}),
      emitEvent: unavailable, finishMatch: unavailable,
    });
    let session;
    let owned = false;
    let disposed = false;
    const dispose = async (reason) => {
      if (disposed) return;
      disposed = true;
      phase = 'finished';
      controller.abort();
      try { await session.finish({ reason }); } catch { throw new SDKError('CLEANUP_FAILED', 'Falló la limpieza de la sesión.'); }
    };
    try {
      let prepared;
      try { prepared = await executable.createSession(context, options); }
      catch { throw new SDKError('PREPARATION_FAILED', 'La fábrica del plugin no pudo preparar la sesión.'); }
      session = prepared?.session;
      requireSDK(session && typeof session === 'object', 'INVALID_SESSION_INTERFACE', 'Se requiere una sesión nueva.');
      requireSDK(!this.#sessions.has(session), 'REUSED_SESSION', 'La fábrica reutilizó un objeto de sesión.');
      this.#sessions.add(session);
      owned = true;
      requireSDK(isObject(prepared) && Object.keys(prepared).length === 2
        && Object.hasOwn(prepared, 'startData') && ['getSnapshot', 'dispatch', 'finish'].every((key) => typeof session[key] === 'function')
        && (manifest.capabilities.pause
          ? typeof session.pause === 'function' && typeof session.resume === 'function'
          : session.pause === undefined && session.resume === undefined),
      'INVALID_SESSION_INTERFACE', 'La preparación o interfaz de sesión es incompatible.');
      const startData = validateStartData(initializationContract, prepared.startData, options, players);
      const readData = async () => {
        let value;
        try { value = await session.getSnapshot(); } catch { throw new SDKError('INVALID_SNAPSHOT', 'No se pudo obtener el snapshot del plugin.'); }
        const data = copyJSON(value, 'INVALID_SNAPSHOT');
        requireSDK(isObject(data), 'INVALID_SNAPSHOT', 'El snapshot del plugin debe ser un objeto JSON.');
        return data;
      };
      await readData();
      requireSDK(!forbiddenAttempt, 'EVENT_DURING_PREPARATION', 'El plugin intentó emitir durante su preparación.');
      phase = 'prepared';
      const methods = ['dispatch', ...(manifest.capabilities.pause ? ['pause', 'resume'] : [])];
      return Object.freeze({
        matchId, manifest, options, players, startData,
        readData, dispose,
        session: Object.freeze(Object.fromEntries(methods.map((key) => [key, session[key].bind(session)]))),
      });
    } catch (error) {
      controller.abort();
      if (owned && typeof session.finish === 'function') {
        try { await dispose('initialization_failed'); } catch { /* Preserve the original validation error. */ }
      }
      if (error instanceof SDKError) throw error;
      throw new SDKError('PREPARATION_FAILED', 'No se pudo validar la sesión preparada.');
    }
  }
}
