import { createGameBridgeClient } from '/sdk/bridge/game-client.mjs';
import { SnakeController } from './controller.mjs';
import { SnakeView } from './view.mjs';

new SnakeController({ bridge: createGameBridgeClient(), view: new SnakeView(document), window, document });

