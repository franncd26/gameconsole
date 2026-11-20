import { RacingRules } from './racing-rules.mjs';

export class RacingSession {
  #context;
  #state;
  #rules;
  #clock;
  constructor(context, _options, { rules = new RacingRules(), clock = Date.now } = {}) {
    this.#context = context;
    this.#rules = rules;
    this.#clock = clock;
    this.#state = context.createState(rules.initial(this.#now()));
  }
  #now() {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Reloj de carrera inválido.');
    return now;
  }
  getSnapshot() { return this.#state.read(); }
  async dispatch({ type, payload }) {
    const state = this.#state.read();
    if (type !== 'STEP' || !this.#rules.validPayload(payload) || state.result !== null) return { outcome: 'rejected' };
    const now = this.#now();
    if (now < state.lastTick) throw new Error('El reloj de carrera retrocedió.');
    const proposal = this.#rules.step(state, payload, now);
    await this.#context.confirmTransition(proposal);
    if (proposal.data.result !== null) await this.#context.finishMatch({ reason: 'completed' });
    return { outcome: 'completed' };
  }
  finish() { /* No fabricated race result or unconfirmed clock update on administrative close. */ }
}
