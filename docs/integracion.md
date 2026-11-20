# Contratos de integración

La consola principal utiliza `/api/sdk/`. Las rutas históricas se conservan como
compatibilidad y no deben confundirse con el contrato de acciones del SDK.

## API SDK vigente

| Método y ruta | Responsabilidad |
| --- | --- |
| GET /api/sdk/catalog | Metadatos públicos de plugins autorizados; sin rutas locales. |
| POST /api/sdk/matches | Crear y activar con `{gameId, options?, players?}`; 201 después de aceptar MATCH_STARTED localmente. |
| GET /api/sdk/matches | Partidas locales, snapshots y estado de entrega. |
| GET /api/sdk/matches/{id} | Snapshot confirmado y entrega del Outbox. |
| POST /api/sdk/matches/{id}/actions | Despachar el sobre de acción SDK; semántica del plugin. |
| POST /api/sdk/matches/{id}/finish | Cierre administrativo con `{reason?}`, idempotente. |
| GET /api/sdk/matches/{id}/results | Consulta de resultados de esa identidad a Go/Scala. |
| GET /api/dashboard | Resumen general de GameStats, compartido con compatibilidad. |
| GET /api/health | Salud de Node; no certifica analítica ni entrega. |

Ejemplo de acción; el host no interpreta las reglas de COMPLETE_LAP:

```json
{"requestId":"lap-001","type":"COMPLETE_LAP","payload":{"durationMs":1234},"expectedVersion":0}
```

`requestId` tiene 1–128 caracteres sin controles; `type` cumple
`[A-Z][A-Z0-9_]{0,63}`; `payload` es un objeto JSON y `expectedVersion` un entero
seguro no negativo opcional. Se rechazan campos desconocidos y datos no JSON.
El manager deduplica antes de comparar expectedVersion, conserva el resultado
original y distingue REQUEST_CONFLICT de VERSION_CONFLICT. La ventana predeterminada
es FIFO de 128 resultados por partida; no persiste tras reinicio ni expulsión.

Acciones de los plugins académicos: Gato PLACE_MARK/RETRY_AI; Snake TICK;
Circuito STEP. El navegador las envía mediante Bridge, sin construir rutas internas.

Un resultado procesado contiene `outcome` (completed, rejected o dependency_failed),
`committed`, `confirmations`, `snapshot` y `error` saneado cuando corresponde.
Un fallo externo posterior a una confirmación conserva sus datos/versiones/eventos.
Un resultado desconocido de HTTP no implica rollback ni autoriza repetir con otra identidad.

Códigos principales: 200 lectura/resultado procesado/cierre, 201 creación, 202
analítica pendiente, 400 contrato inválido, 404 identidad no disponible, 409 conflicto
o lifecycle incompatible, 413 tamaño, 429 admisión/cuota y 502/503/504 dependencia.
`dependency_failed` con cambios confirmados conserva el resultado completo; no se
oculta detrás de un error genérico. Se mantienen no-store, límites de 16 KiB y mismo origen.

## Identidad, confirmación y transporte

El host genera matchId UUID, eventId y timestamp UTC. Cada evento respeta GameStats v1:

```json
{"schemaVersion":1,"eventId":"uuid","timestamp":"2026-11-20T12:00:00Z","gameId":"snake","gameVersion":"1.1.0","matchId":"uuid","type":"APPLE_EATEN","playerId":"human","data":{"points":10}}
```

Campos obligatorios: schemaVersion, eventId, timestamp, gameId, matchId, type y data;
gameVersion y playerId son opcionales en el contrato Go. data es siempre un objeto.
El adaptador valida pertenencia de playerId; solo el host emite inicio y cierre.

| Juego | Eventos de dominio |
| --- | --- |
| Gato | MOVE_PLACED: turn, row, column, symbol; AI_DECISION: algorithm, difficulty, index, score, board. |
| Snake | APPLE_EATEN: incremento points=10; PLAYER_DIED: cause. |
| Circuito | LAP_COMPLETED: lap y durationMs; OBSTACLE_HIT: lap y lane. |

MATCH_STARTED contiene IDs string de participantes y startData validado: símbolos/
dificultad en Gato, gridSize en Snake. MATCH_FINISHED incluye el motivo del host.
No se envía la puntuación acumulada como incremento ni se usan eventos como motor
de física. El cierre administrativo no fabrica una victoria o carrera completada.

1. **Confirmado:** el SDK acepta estado y eventos localmente e incrementa versión.
2. **Entregado:** Outbox confirma en Go el prefijo ordenado de la partida.
3. **Analizado:** Scala devuelve métricas/patrones de un snapshot de Go.

La aceptación de lotes es completa en memoria; no hay atomicidad durable Node–Go.
Outbox reintenta sin bloquear otras partidas; un 409 cuenta como entregado solo si
la consulta confirma el mismo eventId. No se promete entrega exactamente una vez.

## Resultados y dashboard

El host obtiene gameId desde la partida y consulta `GET /results/{gameId}/{matchId}`
en el Go configurado. Con eventos pendientes devuelve 202; no presenta resultados
antiguos como actualizados. También comprueba cambios del prefijo durante la consulta.

Go llama a Scala mediante POST /analyze con `{gameId,matchId,state,events}`.
La respuesta conserva gameId, matchId, state, metrics y patterns. Cada resultado
mantiene label, scope, subjectId, unit, status, reason, source y basis según el perfil.
Provisional/final/unavailable/invalid no se convierten en ceros; tampoco `null`.

`GET /api/dashboard` consulta GET /dashboard de Go y el análisis agregado de Scala.
Devuelve source, scope, consistency, totals, games y matches. Los conteos oficiales
son started/active/finished/events; invalidSamples advierte resultados parciales.
El listado SDK y los conteos recibidos por Go son fuentes distintas.

El panel seleccionado consulta aproximadamente cada 3 s, el dashboard cada 5 s.
Cuadrícula consulta solo vistas abiertas y expuestas mediante un pool compartido
de dos lecturas simultáneas y cadencia aproximada de 5 s, sin duplicar la seleccionada.
Los iframe se mantienen estables y una caída analítica no detiene sus acciones.

## Rutas históricas de compatibilidad

El modo sin SDK conserva GET /api/catalog, POST/GET /api/matches,
GET /api/matches/{id}, POST /api/matches/{id}/action (singular),
POST /api/matches/{id}/finish y GET /api/matches/{id}/results.
Sus cuerpos de acción históricos no son el sobre requestId/type/payload del SDK.
No deben utilizarse para implementar nuevos plugins.

## Importación adicional

Solo el entorno experimental habilita `/api/sdk/plugins/import` y su vista previa
`/preview`, bajo mismo origen local. El registro vivo y los perfiles Scala se
coordinan sin reiniciar Go/Node. Véase el [contrato del importador](sdk-v1/phase-3i2-plugin-importer.md).
La configuración académica mantiene exactamente tres plugins y la importación deshabilitada.
