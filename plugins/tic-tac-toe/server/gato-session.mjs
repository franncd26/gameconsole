import { GatoRules } from './gato-rules.mjs';
import { PrologAdapter, PrologFailure } from './prolog-adapter.mjs';

const exact = (payload, fields) => payload !== null && typeof payload === 'object' && !Array.isArray(payload)
  && Object.keys(payload).length === fields.length && fields.every((key) => Object.hasOwn(payload, key));

/** Game domain only. The SDK owns identity, lifecycle, serialization and public versions. */
export class GatoSession {
  #context;
  #state;
  #rules;
  #prolog;
  constructor(context, options, { rules = new GatoRules(), prolog = new PrologAdapter() } = {}) {
    this.#context = context;
    this.#rules = rules;
    this.#prolog = prolog;
    this.#state = context.createState({ board: Array(9).fill(''), turn: 0, difficulty: options.difficulty,
      winningLine: [], lastDecision: null, result: null, awaitingAI: false });
  }
  getSnapshot() { return this.#state.read(); }
  #moveEvent(data, index, symbol) {
    return { type: 'MOVE_PLACED', playerId: symbol === 'X' ? 'human' : 'prolog',
      data: { turn: data.turn, row: Math.floor(index / 3), column: index % 3, symbol } };
  }
  async dispatch({ type, payload }) {
    const current = this.#state.read();
    if (type === 'PLACE_MARK') {
      if (!exact(payload, ['index']) || !this.#rules.canPlace(current, payload.index, 'X')) return { outcome: 'rejected' };
      const data = this.#rules.place(current, payload.index, 'X');
      await this.#context.confirmTransition({ data, events: [this.#moveEvent(data, payload.index, 'X')] });
      if (data.result !== null) {
        await this.#context.finishMatch({ reason: 'completed' });
        return { outcome: 'completed' };
      }
    } else if (type !== 'RETRY_AI' || !exact(payload, []) || !current.awaitingAI
      || current.result !== null || current.turn % 2 !== 1) return { outcome: 'rejected' };
    return this.#completeAI();
  }
  async #completeAI() {
    const current = this.#state.read();
    let decision;
    try {
      decision = await this.#prolog.decide(current.board, { difficulty: current.difficulty, signal: this.#context.signal });
    } catch (error) {
      if (error instanceof PrologFailure) return { outcome: 'dependency_failed' };
      throw error; // Coordinator/unexpected faults are not reclassified as invalid game actions.
    }
    const next = this.#rules.place(current, decision.index, 'O');
    const data = { ...next, lastDecision: decision };
    await this.#context.confirmTransition({ data, events: [
      { type: 'AI_DECISION', playerId: 'prolog', data: { ...decision, difficulty: current.difficulty, board: [...current.board] } },
      this.#moveEvent(data, decision.index, 'O'),
    ] });
    if (data.result !== null) await this.#context.finishMatch({ reason: 'completed' });
    return { outcome: 'completed' };
  }
  finish() { /* No domain mutation on administrative close. Context signal belongs to the host. */ }
}
