import { GatoSession } from './gato-session.mjs';

export default {
  initializationContract: {
    participants: [
      { id: 'human', role: 'human', required: true },
      { id: 'prolog', role: 'ai', required: true },
    ],
    startData: {
      symbols: { type: 'object', required: true },
      difficulty: { type: 'string', required: true, equalsOption: 'difficulty' },
    },
  },
  createSession(context, options) {
    return {
      startData: { symbols: { human: 'X', prolog: 'O' }, difficulty: options.difficulty },
      session: new GatoSession(context, options),
    };
  },
};
