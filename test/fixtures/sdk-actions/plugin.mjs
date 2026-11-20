// This package is assembled in a temporary test directory; no production catalog entry.
import base, { probes, setDependency } from './transitions.mjs';
export { probes, setDependency };
export const calls = new Map();
export const received = new Map();
let dispatchHook = async () => {};
export const setDispatchHook = (mock) => { dispatchHook = mock; };

export default {
  initializationContract: base.initializationContract,
  createSession(context, options) {
    const prepared = base.createSession(context, options);
    const dispatch = prepared.session.dispatch.bind(prepared.session);
    prepared.session.dispatch = async (action) => {
      calls.set(context.matchId, (calls.get(context.matchId) ?? 0) + 1);
      received.set(context.matchId, action);
      await dispatchHook(action, context);
      if (action.type === 'CUSTOM_NOOP') return { outcome: 'completed' };
      if (action.type === 'FAIL_BEFORE') throw new Error('C:/private/action.mjs: secret');
      if (action.type === 'BUILD_DEEP') {
        let data = { value: 1 };
        for (let index = 0; index < 62; index++) data = { nested: data };
        await context.confirmTransition({ data, events: [] });
        return { outcome: 'completed' };
      }
      return dispatch(action);
    };
    return prepared;
  },
};
