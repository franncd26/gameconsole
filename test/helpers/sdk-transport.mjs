import { fileURLToPath } from 'node:url';
import { GameRegistry } from '../../server/sdk/registry.mjs';
import { GamePluginLoader } from '../../server/sdk/loader.mjs';
import { GameSessionFactory } from '../../server/sdk/session-factory.mjs';
import { GameInstanceManager } from '../../server/sdk/instance-manager.mjs';
import { OutboxEventSink } from '../../server/sdk/outbox-event-sink.mjs';
import { EventOutbox } from '../../server/outbox.mjs';

/** Explicit fixture composition shared only by unit tests and the optional manual smoke. */
export async function createFixtureTransport({ goURL = 'http://transport.test', fetcher, retryMs = 1 } = {}) {
  const registry = new GameRegistry();
  await registry.register(fileURLToPath(new URL('../fixtures/sdk-transport/racing/', import.meta.url)));
  const loader = new GamePluginLoader(registry, { trustedIds: ['racing'] });
  const factory = new GameSessionFactory(loader);
  const outbox = new EventOutbox(goURL, { ...(fetcher ? { fetcher } : {}), retryMs });
  const sink = new OutboxEventSink(outbox);
  const manager = new GameInstanceManager(factory, { eventSink: sink });
  return { registry, loader, factory, manager, sink, outbox };
}
