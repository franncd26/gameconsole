import { RacingSession } from './racing-session.mjs';

export default {
  initializationContract: {
    participants: [{ id: 'human', role: 'human', required: true }], startData: {},
  },
  createSession(context, options) {
    return { startData: {}, session: new RacingSession(context, options) };
  },
};
