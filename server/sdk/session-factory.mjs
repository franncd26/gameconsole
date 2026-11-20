import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { GamePluginLoader } from './loader.mjs';
import { validateOptions } from './options.mjs';
import { validatePlayers, validateStartData } from './initialization.mjs';
import { copyJSON, freezeJSON, isObject, requireSDK, SDKError } from './values.mjs';

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
    let coordinatedState;
    const operationScope = new AsyncLocalStorage();
    const unavailable = (event) => {
      if (phase === 'preparing') forbiddenAttempt = true;
      if (phase !== 'preparing' && ['MATCH_STARTED', 'MATCH_FINISHED'].includes(event?.type)) {
        throw new SDKError('RESERVED_EVENT', 'Los eventos de ciclo de vida pertenecen al anfitrión.');
      }
      throw new SDKError(phase === 'preparing' ? 'EVENT_DURING_PREPARATION' : 'EVENTS_UNAVAILABLE',
        'Eventos de dominio y solicitudes de cierre del plugin no están habilitados en esta fase.');
    };
    const context = Object.freeze({
      gameId: manifest.id, gameVersion: manifest.version, matchId, players,
      logger: quietLogger, signal: controller.signal, services: Object.freeze({}),
      emitEvent: unavailable,
      createState(initialData) {
        requireSDK(phase === 'preparing' && coordinatedState === undefined,
          'INVALID_STATE_INITIALIZATION', 'La celda de estado solo puede crearse una vez durante preparación.');
        const data = copyJSON(initialData, 'INVALID_SNAPSHOT');
        requireSDK(isObject(data), 'INVALID_SNAPSHOT', 'La celda requiere un objeto JSON.');
        coordinatedState = freezeJSON(data);
        return Object.freeze({ read: () => coordinatedState });
      },
      confirmTransition(proposal) {
        if (phase === 'preparing') { forbiddenAttempt = true; return unavailable(); }
        const scope = operationScope.getStore();
        requireSDK(phase === 'running' && scope?.active, 'TRANSITIONS_UNAVAILABLE',
          'Solo se puede confirmar dentro de una operación coordinada activa.');
        return scope.bridge.confirm(proposal);
      },
      finishMatch(request) {
        const scope = operationScope.getStore();
        if (phase === 'running' && scope?.active) return scope.bridge.requestFinish(request);
        return unavailable(request);
      },
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
      const readPluginData = async () => {
        let value;
        try { value = await session.getSnapshot(); } catch { throw new SDKError('INVALID_SNAPSHOT', 'No se pudo obtener el snapshot del plugin.'); }
        const data = copyJSON(value, 'INVALID_SNAPSHOT');
        requireSDK(isObject(data), 'INVALID_SNAPSHOT', 'El snapshot del plugin debe ser un objeto JSON.');
        return data;
      };
      const initialData = await readPluginData();
      requireSDK(coordinatedState === undefined || isDeepStrictEqual(initialData, coordinatedState),
        'INVALID_SNAPSHOT', 'El snapshot inicial debe representar la celda declarada.');
      const readData = () => coordinatedState === undefined ? readPluginData() : Promise.resolve(copyJSON(coordinatedState));
      requireSDK(!forbiddenAttempt, 'EVENT_DURING_PREPARATION', 'El plugin intentó emitir durante su preparación.');
      phase = 'prepared';
      const methods = ['dispatch', ...(manifest.capabilities.pause ? ['pause', 'resume'] : [])];
      const facade = Object.freeze(Object.fromEntries(methods.map((key) => [key, (...args) => {
        requireSDK(!['closing', 'finished'].includes(phase), 'SESSION_CLOSED', 'La sesión ya no acepta operaciones del juego.');
        requireSDK(phase !== 'activating', 'SESSION_NOT_ACTIVE', 'La activación aún no fue aceptada.');
        requireSDK(coordinatedState === undefined || operationScope.getStore()?.active,
          'TRANSITIONS_UNAVAILABLE', 'La sesión con celda solo ejecuta operaciones coordinadas.');
        return session[key](...args);
      }])));
      return Object.freeze({
        matchId, manifest, options, players, startData,
        readData, dispose,
        hasCoordinatedState: coordinatedState !== undefined,
        stageTransition(value) {
          const data = copyJSON(value, 'INVALID_TRANSITION');
          requireSDK(isObject(data), 'INVALID_TRANSITION', 'La transición requiere un candidato JSON.');
          return freezeJSON(data);
        },
        // Host-only, synchronous reference replacement of an already validated/frozen candidate.
        publishTransition(data) { coordinatedState = data; },
        async withOperation(bridge, execute) {
          requireSDK(coordinatedState !== undefined, 'COORDINATED_STATE_REQUIRED', 'El plugin no declaró una celda coordinada.');
          requireSDK(phase === 'running', 'INVALID_LIFECYCLE', 'La sesión debe estar running.');
          const scope = { bridge, active: true };
          return operationScope.run(scope, async () => {
            try { return await execute(facade); } finally { scope.active = false; }
          });
        },
        setLifecyclePhase(next) {
          const allowed = { prepared: ['activating', 'closing'], activating: ['running', 'closing'], running: ['closing'] };
          requireSDK(allowed[phase]?.includes(next), 'INVALID_LIFECYCLE', 'Transición interna de ciclo de vida inválida.');
          phase = next;
        },
        session: facade,
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
