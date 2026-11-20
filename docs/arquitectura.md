# Arquitectura y decisiones técnicas

GameConsole integra una consola web, tres videojuegos orientados a objetos, un motor de decisiones en Prolog y la plataforma GameStats. Cada componente mantiene una responsabilidad definida.

```text
Navegador: Biblioteca, partidas, cuadrícula y estadísticas
       │                   │
       │             iframe + GameBridgeClient
       ▼                   ▼
API de GameConsole ── GameInstanceManager
       │                   │
       │              Sesión + reglas del juego
       │                   └── Gato → PrologAdapter → SWI-Prolog
       ▼
GameEventAdapter → EventOutbox → GameStats Go → GameStats Scala
       ▲                                               │
       └───────────── Consultas de resultados ─────────┘
```

## Orientación a objetos y módulos de juego

Los tres videojuegos son paquetes autónomos ubicados en `plugins/`. Cada uno contiene `game.json`, código de servidor, interfaz web y un perfil de estadísticas.

- **Reglas:** `GatoRules`, `SnakeRules` y `RacingRules` encapsulan las decisiones propias de cada juego.
- **Sesiones:** los objetos `GameSession` de cada paquete administran su estado, reciben acciones y proponen transiciones confirmables.
- **Abstracción:** `GameSessionFactory` crea sesiones mediante una interfaz común. El código anfitrión no necesita interpretar los movimientos de cada videojuego.
- **Encapsulación:** las reglas y el estado oficial se ejecutan en Node.js; la interfaz web solo envía intenciones y representa los datos confirmados.

Se privilegia la composición entre componentes frente a introducir herencia donde no resulta necesaria.

## Componentes principales

| Componente | Responsabilidad |
| --- | --- |
| `GameRegistry` y `GamePluginLoader` | Descubrir paquetes, validar metadatos y cargar implementaciones autorizadas. |
| `GameSessionFactory` | Validar opciones y participantes; preparar una sesión independiente. |
| `GameInstanceManager` | Administrar partidas por `matchId`, su ciclo de vida, versiones y acciones. |
| `HostBridge` y `GameBridgeClient` | Comunicar la consola con las interfaces de los juegos dentro de iframes. |
| `PrologAdapter` | Enviar el tablero de Gato a SWI-Prolog y recibir su decisión. |
| `GameEventAdapter` y `EventOutbox` | Construir eventos compatibles y entregarlos a GameStats. |

## Inteligencia de juego en Prolog

En **Gato**, el usuario juega contra la computadora. Node proporciona el estado del tablero a SWI-Prolog y aplica la casilla calculada por el programa lógico. La dificultad alta utiliza **minimax**; las demás dificultades aplican estrategias basadas en reglas y prioridades. La respuesta se valida antes de confirmar la jugada.

La estrategia no consiste en escoger movimientos aleatorios. En caso de error del proceso Prolog, la jugada humana ya confirmada permanece y puede reintentarse la decisión de la computadora.

## Concurrencia e identidad

Cada partida recibe un `matchId` único, estado independiente y cola de operaciones propia. Es posible ejecutar varias instancias del mismo juego o de juegos distintos, tanto en una consola como en varias pestañas.

El servidor serializa las acciones **dentro de una misma partida** sin imponer una cola única a todas las sesiones. El `EventOutbox` conserva el orden de los eventos por partida y reintenta la comunicación con Go. Los identificadores `gameId`, `matchId` y `eventId` evitan mezclar eventos concurrentes.

## Patrones de diseño

| Patrón | Aplicación concreta |
| --- | --- |
| **Factory** | `GameSessionFactory` crea sesiones a partir del contrato común de cada plugin. |
| **Registry** | `GameRegistry` permite descubrir juegos sin una selección fija por identificador. |
| **Adapter** | `GameEventAdapter`, `OutboxEventSink` y `PrologAdapter` conectan contratos diferentes. |
| **Facade** | La API SDK y el Bridge exponen operaciones acotadas sin entregar objetos internos al navegador. |
| **Observer** | Las suscripciones del Bridge notifican cambios de snapshots y resultados a las vistas. |

## Estadísticas y límites

GameConsole confirma el estado de juego, Go recibe eventos y Scala calcula las métricas. La consola consulta los resultados mientras las partidas están abiertas y presenta también las estadísticas generales. **No recalcula métricas de GameStats en el navegador.**

Los datos de partida y los eventos pendientes no son persistentes entre reinicios. El control entre pestañas mediante Web Locks depende del navegador y no representa una autenticación global. El deployment académico incluye exactamente tres juegos.

Los contratos de eventos y consultas se describen en [integración](integracion.md).
