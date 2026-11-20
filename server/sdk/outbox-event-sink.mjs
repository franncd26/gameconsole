import { EventOutbox } from '../outbox.mjs';
import { requireSDK } from './values.mjs';

/** Local acceptance only. EventOutbox remains the sole owner of queues and retries. */
export class OutboxEventSink {
  #outbox;

  constructor(outbox) {
    requireSDK(outbox instanceof EventOutbox, 'INVALID_CONFIGURATION', 'Se requiere EventOutbox.');
    this.#outbox = outbox;
  }

  accept(event) { this.#outbox.enqueueBatch([event]); }
  acceptBatch(events) { this.#outbox.enqueueBatch(events); }
}
