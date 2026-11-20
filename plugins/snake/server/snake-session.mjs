import { SnakeRules } from './snake-rules.mjs';

export class SnakeSession {
  #context;
  #state;
  #rules;
  #random;
  constructor(context, options, { rules = new SnakeRules(), random = Math.random } = {}) {
    this.#context = context;
    this.#rules = rules;
    this.#random = random;
    this.#state = context.createState(this.#withFood(rules.initial(options.size)));
  }
  #withFood(data) {
    const free = this.#rules.freeCells(data.size, data.body);
    if (!free.length) return { ...data, food: null, result: 'board_completed' };
    const sample = this.#random();
    if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new Error('Fuente aleatoria inválida.');
    return { ...data, food: free[Math.min(free.length - 1, Math.floor(sample * free.length))] };
  }
  getSnapshot() { return this.#state.read(); }
  async dispatch({ type, payload }) {
    const state = this.#state.read();
    if (type !== 'TICK' || !this.#rules.validPayload(payload) || state.result !== null) return { outcome: 'rejected' };
    const proposal = this.#rules.tick(state, payload.direction);
    const data = proposal.needsFood ? this.#withFood(proposal.data) : proposal.data;
    await this.#context.confirmTransition({ data, events: proposal.events });
    if (data.result !== null) await this.#context.finishMatch({ reason: 'completed' });
    return { outcome: 'completed' };
  }
  finish() { /* Administrative close does not mutate confirmed domain data. */ }
}
