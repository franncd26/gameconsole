import { createGameBridgeClient } from '/sdk/bridge/game-client.mjs';
import { GatoController } from './controller.mjs';
import { GatoView } from './view.mjs';

new GatoController({ bridge: createGameBridgeClient(), view: new GatoView(document), window, document });

