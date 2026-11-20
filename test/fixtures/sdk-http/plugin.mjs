import base from './base.mjs';

// Test-only hooks. Never installed in plugins/ or exposed by the HTTP host.
export const hooks = new Map();
export default {
  initializationContract: base.initializationContract,
  createSession(context, options) {
    if (options.fail) throw new Error('C:\\private\\plugin.mjs: confidential preparation');
    const prepared = base.createSession(context, options);
    const dispatch = prepared.session.dispatch;
    prepared.session.dispatch = async (action) => {
      if (action.type === 'THROW') throw new Error('C:\\private\\plugin.mjs: confidential dispatch');
      if (action.type === 'WAIT_LAP') await hooks.get(context.matchId)?.();
      if (['WAIT_LAP', 'FAIL_AFTER_LAP', 'CLOSE'].includes(action.type)) {
        await dispatch({ ...action, type: 'COMPLETE_LAP' });
        if (action.type === 'FAIL_AFTER_LAP') throw new Error('C:\\private\\dependency.mjs: confidential dependency');
        if (action.type === 'CLOSE') await context.finishMatch({ reason: 'completed' });
        return { outcome: 'completed' };
      }
      return dispatch(action);
    };
    return prepared;
  },
};
