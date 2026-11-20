export default {
  initializationContract: { participants: [{ id: 'human', role: 'human', required: true }], startData: {} },
  createSession(context) {
    const state = context.createState({ count: 0 });
    return { startData: {}, session: {
      getSnapshot: state.read,
      async dispatch({ type, payload }) {
        if (Object.keys(payload).length || !['INCREMENT', 'COMPLETE'].includes(type)) return { outcome: 'rejected' };
        if (type === 'COMPLETE') { context.finishMatch({ reason: 'completed' }); return { outcome: 'completed' }; }
        await context.confirmTransition({ data: { count: state.read().count + 1 }, events: [{ type: 'COUNTER_INCREMENTED', playerId: 'human', data: { amount: 1 } }] });
        return { outcome: 'completed' };
      },
      finish() {},
    } };
  },
};
