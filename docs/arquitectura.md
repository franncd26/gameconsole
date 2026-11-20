# Arquitectura y decisiones técnicas

GameConsole separa la interfaz anfitriona, el runtime SDK, los videojuegos y la
analítica. La configuración académica carga Gato, Snake y Circuito; el anfitrión
selecciona paquetes por metadatos y confianza, sin condiciones por gameId en la API SDK.

```text
Consola web → HostBridge ↔ iframe del plugin / GameBridgeClient
                    ↓ HTTP /api/sdk/
Registry → Loader → Factory → GameInstanceManager → Session / Rules
                                      │                 │
                                      │         Gato → PrologAdapter → SWI-Prolog
                                      ↓
                     GameEventAdapter → OutboxEventSink → EventOutbox
                                                           ↓
                                                    GameStats Go
                                                           ↓
                                                    GameStats Scala
```

## Paquetes y orientación a objetos

Cada paquete de `plugins/` contiene `game.json`, módulos de servidor, recursos web
y perfil analítico. `GatoRules`, `SnakeRules` y `RacingRules` encapsulan reglas y
física; sus clases Session coordinan acciones con el contexto SDK. Gato incluye
su propio adaptador y programa Prolog. Los plugins no importan las clases históricas
del host ni comparten estado mutable de partida.

Cada sesión usa una celda `context.createState`. Una transición propone nuevos
datos y sus eventos mediante `confirmTransition`; el host controla aceptación,
ciclo de vida y versión pública. Las vistas solo representan snapshots y envían
intenciones. No deciden victorias, colisiones, IA ni estadísticas.

## Runtime y concurrencia

- **GameRegistry:** descubre y valida metadatos sin importar código.
- **GamePluginLoader:** carga exclusivamente módulos registrados y confiables y
  comprueba su interfaz. Descubrimiento no equivale a autorización.
- **GameSessionFactory:** aplica opciones/defaults y valida participantes, datos
  iniciales y una sesión independiente antes de publicarla.
- **GameInstanceManager:** mantiene un Map por UUID, serializa operaciones de cada
  partida y administra lifecycle, versiones e historial acotado de requestId.

Los tres manifiestos permiten múltiples instancias. Una partida no bloquea a otra;
la validación genérica de `multipleInstances:false` sigue disponible para otros
paquetes. Abrir el mismo UUID en otra pestaña crea otra vista de la misma sesión.
Web Locks coordina el control local entre pestañas compatibles; el servidor conserva
la autoridad y no existe exclusión global entre equipos.

## Presentación, Bridge y Prolog

ConsoleApp, CatalogView, MatchWorkspace y StatsPanel distribuyen responsabilidades
del host. Un Map mantiene contenedores e iframe estables al cambiar selección o
estadísticas. El Bridge valida mensajes, fuente, origen y canal por iframe.
Los juegos se cargan con `sandbox="allow-scripts"`, sin allow-same-origin.
Origen opaco no autentica por sí solo un documento; navegar exige un montaje nuevo.

Visibilidad, pausa manual y reanudación son estados locales de presentación.
No modifican el lifecycle SDK ni los tiempos analíticos. Las consultas estadísticas
se acotan y no participan en la cola de acciones.

Gato ejecuta sus tres estrategias en SWI-Prolog: reglas básicas, reglas tácticas y
minimax. Node invoca un proceso sin shell, con timeout, límites de salida y validación
de la respuesta. La jugada humana se confirma antes de consultar la IA; si falla
la dependencia, la X permanece y RETRY_AI puede continuar con otra solicitud.

## Eventos, analítica y patrones

| Patrón | Aplicación y razón |
| --- | --- |
| Registry y Factory | Separan catálogo, carga confiable y construcción de sesiones; evitan seleccionar clases por gameId. |
| Adapter | GameEventAdapter crea el sobre v1; OutboxEventSink adapta aceptación local al transporte existente; PrologAdapter delimita el proceso externo. |
| Facade | API SDK, ConsoleAPI y Bridge ofrecen operaciones genéricas sin exponer handles internos al navegador. |
| Observer | Suscriptores de Bridge y recursos estadísticos actualizan vistas mediante copias defensivas. |
| State | Lifecycle del host y celda de dominio delimitan autoridades y transiciones; no hay una segunda versión mutable en el plugin. |
| Dependency Injection | Contexto, sink, fetcher, reloj, aleatoriedad y adaptador de IA permiten aislamiento y pruebas deterministas. |

EventOutbox conserva orden por matchId, reintenta fallos y verifica un 409 por eventId.
La aceptación de un lote es completa en memoria, no una transacción durable con Go.
Go organiza eventos y snapshots; Scala interpreta perfiles y calcula métricas y
patrones. GameConsole no sustituye esos cálculos por sumas o promedios locales.

## Compatibilidad y extensión experimental

`server/games.mjs`, sus clases Match/TicTacToe/Snake/Racing y las rutas `/api/matches`
pertenecen a la implementación histórica de compatibilidad. No son la base de los
plugins actuales. Con SDK deshabilitado, `/` conserva esa interfaz histórica.

El [importador experimental](sdk-v1/phase-3i2-plugin-importer.md) agrega paquetes
autorizados al registro vivo sin reemplazar el Manager. Publica perfiles persistentes
y un supervisor reinicia solo el proceso Scala, con verificación de carga y rollback.
Está separado del entorno académico; no permite ejecutar JAR directamente.

Límites: memoria no durable, 500 partidas, 32 canales por HostBridge, sin cuentas
ni entrega exactamente una vez. El sandbox web no protege al host de código Node
no confiable. Los [contratos HTTP y eventos](integracion.md) detallan los fallos.
