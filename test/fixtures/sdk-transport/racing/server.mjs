export default {
  initializationContract: {
    participants: [{ id: 'p1', role: 'human', required: true }],
    startData: {},
  },
  createSession(context) {
    const state = context.createState({ laps: 0, totalDurationMs: 0 });
    return {
      startData: {},
      session: {
        getSnapshot: state.read,
        async dispatch({ type, payload }) {
          const durations = type === 'COMPLETE_LAP' ? [payload.durationMs]
            : type === 'COMPLETE_TWO_LAPS' && Array.isArray(payload.durations) && payload.durations.length === 2
              ? payload.durations : [];
          if (durations.length === 0 || durations.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 600_000)) {
            return { outcome: 'rejected' };
          }
          const previous = state.read();
          await context.confirmTransition({
            data: { laps: previous.laps + durations.length,
              totalDurationMs: previous.totalDurationMs + durations.reduce((sum, value) => sum + value, 0) },
            events: durations.map((durationMs, index) => ({
              type: 'LAP_COMPLETED', playerId: 'p1', data: { lap: previous.laps + index + 1, durationMs },
            })),
          });
          return { outcome: 'completed' };
        },
        finish() {},
      },
    };
  },
};
