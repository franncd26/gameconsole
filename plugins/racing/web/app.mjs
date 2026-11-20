import { createGameBridgeClient } from '/sdk/bridge/game-client.mjs';
import { RacingController } from './controller.mjs';
import { RacingView } from './view.mjs';

new RacingController({ bridge: createGameBridgeClient(), view: new RacingView(document), window, document });

