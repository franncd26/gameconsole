// Only an import sentinel, never shared match state.
globalThis.__sdkCounterImported = true;

export default {
  initializationContract: {
    participants: [
      { id: 'human', role: 'human', required: true },
      { id: 'helper', role: 'ai', required: false },
    ],
    startData: {
      size: { type: 'integer', required: true, equalsOption: 'size' },
      actor: { type: 'playerId', required: true },
    },
  },
  createSession(context, options) {
    if (options.mode === 'throw') throw new Error('private-path-and-secret');
    if (options.mode === 'event') context.emitEvent({ type: 'BAD', data: {} });
    if (options.mode === 'caught-event') {
      try { context.finishMatch({ reason: 'bad' }); } catch { /* Host must still reject preparation. */ }
    }
    let value = options.initial;
    let closed = false;
    const history = [];
    return {
      session: {
        getSnapshot() {
          return options.mode === 'bad-snapshot' ? { value: undefined } : {
            value, history, closed,
            protectedInputs: Object.isFrozen(context) && Object.isFrozen(options)
              && Object.isFrozen(context.players) && Object.isFrozen(context.players[0]),
          };
        },
        dispatch: options.mode === 'bad-session' ? null : async ({ type, payload }) => {
          if (type !== 'ADD' || !Number.isSafeInteger(payload.amount)) throw new Error('invalid action');
          value += payload.amount;
          history.push(payload.amount);
          return { outcome: 'completed', committed: true };
        },
        finish() { closed = true; },
      },
      startData: options.mode === 'missing-start' ? {} : {
        size: options.mode === 'bad-start' ? 13 : options.size,
        actor: options.mode === 'bad-player' ? 'unknown' : context.players[0].id,
      },
    };
  },
};
