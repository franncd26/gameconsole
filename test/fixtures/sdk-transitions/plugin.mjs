// Test instrumentation only. Each session owns a separate immutable state cell.
export const probes = new Map();
let dependency = async () => { throw new Error('C:/private/mock-prolog.mjs: secret'); };
export const setDependency = (mock) => { dependency = mock; };

export default {
  initializationContract: {
    participants: [
      { id: 'human', role: 'human', required: true },
      { id: 'ai', role: 'ai', required: true },
    ],
    startData: {},
  },
  createSession(context) {
    const state = context.createState({ count: 0, moves: [], awaitingAI: false });
    probes.set(context.matchId, { context, read: state.read });
    const add = (amount, events) => context.confirmTransition({
      data: { ...state.read(), count: state.read().count + amount }, events,
    });
    const countEvent = (amount) => ({ type: 'COUNT_CHANGED', data: { delta: amount }, playerId: 'human' });
    return {
      startData: {},
      session: {
        getSnapshot: state.read,
        async dispatch({ type, payload = {} }) {
          switch (type) {
            case 'ADD':
              if (!Number.isSafeInteger(payload.amount) || payload.amount <= 0) return { outcome: 'rejected' };
              await add(payload.amount, [countEvent(payload.amount)]);
              break;
            case 'SILENT':
              await add(1, []);
              break;
            case 'BATCH':
              await add(2, [countEvent(1), { type: 'SECOND_EVENT', data: { delta: 1 }, playerId: 'ai' }]);
              break;
            case 'TWO_TRANSITIONS':
              await add(1, [countEvent(1)]);
              await add(1, [{ type: 'SECOND_EVENT', data: { delta: 1 } }]);
              break;
            case 'PROPOSE':
              await context.confirmTransition(payload);
              break;
            case 'HUMAN_MOVE':
              if (state.read().moves.length !== 0) return { outcome: 'rejected' };
              await context.confirmTransition({
                data: { ...state.read(), moves: ['human'], awaitingAI: true },
                events: [{ type: 'MOVE_PLACED', data: { symbol: 'X' }, playerId: 'human' }],
              });
              await dependency();
              break;
            case 'RETRY_AI':
              if (!state.read().awaitingAI) return { outcome: 'rejected' };
              await dependency();
              await context.confirmTransition({
                data: { ...state.read(), moves: [...state.read().moves, 'ai'], awaitingAI: false },
                events: [{ type: 'AI_DECISION', data: { symbol: 'O' }, playerId: 'ai' }],
              });
              break;
            case 'CLOSE':
              await add(1, [countEvent(1)]);
              await context.finishMatch({ reason: 'completed' });
              break;
            case 'CLOSE_THEN_CONFIRM':
              await context.finishMatch({ reason: 'completed' });
              await add(1, [countEvent(1)]);
              break;
            case 'UNAWAITED':
              add(1, [countEvent(1)]);
              break;
            case 'CAUGHT_FAILURE':
              try { await add(1, [{ type: 'MATCH_FINISHED', data: {} }]); } catch { /* Must not hide failure. */ }
              try { await add(1, [countEvent(1)]); } catch { /* Must not resume after the failed transition. */ }
              break;
            default:
              return { outcome: 'rejected' };
          }
          return { outcome: 'completed' };
        },
        finish() {},
      },
    };
  },
};
