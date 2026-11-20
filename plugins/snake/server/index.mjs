import { SnakeSession } from './snake-session.mjs';

export default {
  initializationContract: {
    participants: [{ id: 'human', role: 'human', required: true }],
    startData: { gridSize: { type: 'integer', required: true, equalsOption: 'size' } },
  },
  createSession(context, options) {
    return { startData: { gridSize: options.size }, session: new SnakeSession(context, options) };
  },
};
