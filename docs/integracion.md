# Integración con GameStats

GameConsole utiliza GameStats como sistema externo de recepción y análisis de eventos. Las reglas de juego permanecen en Node.js; **Go recibe los eventos y Scala calcula las estadísticas**.

## Identificación y envío de eventos

Cada partida dispone de un `matchId` UUID. Los eventos incluyen los campos requeridos por el contrato v1 de GameStats:

| Campo | Significado |
| --- | --- |
| `schemaVersion` | Versión del contrato de eventos; valor `1`. |
| `eventId` | Identificador único del evento. |
| `timestamp` | Fecha y hora UTC en formato compatible con RFC 3339. |
| `gameId` | Videojuego al que corresponde el evento. |
| `matchId` | Instancia de partida que lo generó. |
| `type` | Tipo de acontecimiento registrado. |
| `data` | Objeto JSON con la información del evento. |

`gameVersion` y `playerId` se incorporan cuando corresponda. `MATCH_STARTED` y `MATCH_FINISHED` permiten registrar las instancias iniciadas y finalizadas.

Los eventos de dominio utilizados por los tres juegos incluyen:

| Juego | Eventos principales |
| --- | --- |
| **Gato** | `MOVE_PLACED` y `AI_DECISION`. |
| **Snake** | `APPLE_EATEN` y `PLAYER_DIED`. |
| **Circuito** | `LAP_COMPLETED` y `OBSTACLE_HIT`. |

`GameEventAdapter` construye y valida los eventos. `EventOutbox` los envía en orden por partida a la API de Go, con reintentos ante fallos temporales. Un fallo de comunicación no debe bloquear las acciones de otras partidas; los eventos todavía no entregados permanecen en memoria.

## Contrato de la consola web

La interfaz utiliza el Bridge del SDK para solicitar acciones. La API genérica expone:

| Método y ruta | Uso |
| --- | --- |
| `GET /api/sdk/catalog` | Consultar los tres videojuegos habilitados. |
| `POST /api/sdk/matches` | Crear una partida con `gameId` y opciones. |
| `GET /api/sdk/matches` | Consultar las partidas del proceso. |
| `GET /api/sdk/matches/{id}` | Obtener el estado confirmado de una partida. |
| `POST /api/sdk/matches/{id}/actions` | Ejecutar una acción del juego. |
| `POST /api/sdk/matches/{id}/finish` | Finalizar administrativamente una partida. |
| `GET /api/sdk/matches/{id}/results` | Obtener el análisis de esa partida desde GameStats. |
| `GET /api/dashboard` | Obtener las estadísticas generales desde GameStats. |

Las acciones incorporan `requestId`, `type`, `payload` y, opcionalmente, `expectedVersion` para controlar versiones y solicitudes repetidas. Cada plugin define sus propias acciones: `PLACE_MARK` y `RETRY_AI` en Gato, `TICK` en Snake y `STEP` en Circuito.

## Actualización de estadísticas

La información se obtiene desde GameStats en tres niveles:

1. **Confirmación local:** GameConsole acepta una transición y sus eventos en memoria.
2. **Entrega:** el Outbox confirma que Go recibió los eventos.
3. **Análisis:** Scala calcula las métricas a partir de los eventos de la partida.

Una confirmación local no equivale a una entrega o a un análisis terminado.

El panel de la partida seleccionada consulta los resultados periódicamente (aproximadamente cada 3 segundos); las estadísticas generales se actualizan aproximadamente cada 5 segundos. Las tarjetas de la cuadrícula también presentan resultados individuales cuando están visibles.

Las métricas pueden aparecer como **provisionales**, **finales** o **no disponibles**, según el estado de la partida y el perfil de GameStats. La consola conserva esa distinción y no convierte un valor inexistente en cero.

Go ofrece las consultas de eventos y resultados; Scala interpreta los perfiles analíticos de Gato, Snake y Circuito. GameConsole no calcula por su cuenta puntuaciones agregadas, promedios ni patrones que correspondan a GameStats.

## Manejo de errores y límites

Los envíos se reintentan sin bloquear otras partidas. Los datos de juego y el Outbox son volátiles; un reinicio puede perder información pendiente. No se garantiza entrega exactamente una vez ante todas las fallas posibles.

El cierre administrativo de una partida no equivale a una victoria. Si Prolog falla después de aceptar el movimiento humano, la jugada se conserva y el oponente puede reintentarse.

La arquitectura general se describe en [arquitectura](arquitectura.md); la instalación y ejecución se explican en el [README](../README.md).
