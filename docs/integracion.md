# Contrato de integración

La fuente del contrato v1 es GameStats. No se cambian sus campos obligatorios:
`schemaVersion: 1`, `eventId`, `timestamp`, `gameId`, `matchId`, `type`, `data`.
Se incluyen `gameVersion` y, para acciones de jugador, `playerId`.
`timestamp` usa ISO/RFC3339 UTC y `data` siempre es un objeto JSON.

| Juego | Eventos y datos |
| --- | --- |
| Todos | MATCH_STARTED con players; MATCH_FINISHED con reason. |
| Gato | Inicio con human/X y prolog/O; MOVE_PLACED con turn, row, column y symbol; AI_DECISION con algoritmo, índice, evaluación y tablero. |
| Snake | APPLE_EATEN con incremento points=10; PLAYER_DIED con cause. |
| Circuito | LAP_COMPLETED con lap y durationMs; OBSTACLE_HIT con lap y lane. |

No se envía la puntuación acumulada como incremento. Los eventos adicionales
AI_DECISION y OBSTACLE_HIT son compatibles con el sobre y no alteran los perfiles.

## API de GameConsole

| Método y ruta | Responsabilidad |
| --- | --- |
| GET /api/catalog | Los tres juegos disponibles. |
| GET /api/health | Salud de Node, sin prometer salud de dependencias. |
| POST /api/matches | Crear partida con gameId; responde 201 y snapshot. |
| GET /api/matches | Listar partidas locales y estado de envío. |
| GET /api/matches/{id} | Snapshot y entregas de una partida. |
| POST /api/matches/{id}/action | Ejecutar una acción legal. |
| POST /api/matches/{id}/finish | Cierre por abandono, repetible sin duplicar cierre. |
| GET /api/matches/{id}/results | Consultar resultados reales de GameStats. |
| GET /api/dashboard | Consultar resumen real de GameStats. |

Acciones: Gato `{index:0..8}` o `{retryAI:true}`; Snake
`{direction:"up|down|left|right"}`; Circuito `{lane:0..2,accelerate:true,brake:false}`.
Solicitudes inválidas: 400; inexistentes: 404; partida cerrada/turno pendiente:409;
capacidad:429; dependencia no disponible:502/503. Un fallo de Prolog responde500
y permite recuperar el snapshot para reintentar la IA.

## Extensión de GameStats

Go agrega GET /dashboard y Scala POST /analyze-summary. La respuesta contiene
`source:"GameStats / Scala"`, `scope:"current_process"`, `totals`, `games` y
`matches`. Los conteos son started/active/finished/events. Cada juego incluye
métricas aditivas, sus unidades y `invalidSamples` para advertir datos parciales.
GET /results conserva su formato y sus estados provisional/final/unavailable/invalid.
