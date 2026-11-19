# Fase 2B.1 — activación y cierre con aceptación local

Se conserva `create` como preparación y se añaden `activate` y `discard`. Solo
se implementan eventos de ciclo de vida y transporte mediante una interfaz
inyectable; las pruebas utilizan exclusivamente un EventSink en memoria. No hay
integración real del SDK con HTTP, Go, Scala ni EventOutbox. Los juegos históricos
y sus rutas no importan este runtime.

## Interfaces exactas

```js
new GameInstanceManager(factory, { limit: 500, eventSink })
await manager.create(gameId, configuration) // prepared; no emite
await manager.activate(matchId)            // running solo tras aceptar MATCH_STARTED
await manager.finish(matchId, { reason: 'completed' })
await manager.discard(matchId)             // solo prepared; limpia y elimina
await manager.getSnapshot(matchId)
await manager.list()
manager.size
```

Las interfaces de 2A siguen disponibles; `eventSink` es opcional para preparar,
leer y cerrar localmente una sesión no activada. Activar sin sink falla y descarta
la preparación. `discard` resuelve sin valor o rechaza con error de limpieza,
siempre eliminando el registro al terminar el intento de limpieza.

`GameEventAdapter` se importa desde `server/sdk/event-adapter.mjs`:

```js
const adapter = new GameEventAdapter({ gameId, gameVersion, matchId, players });
adapter.createMatchStarted(startData);
adapter.createMatchFinished({ reason });
adapter.createDomainEvent({ type, data, playerId }); // solo construcción; no publicación
```

El anfitrión conserva el adapter; no lo inyecta al plugin. La identidad procede
del handle de fábrica; `players` es el arreglo interno `{id,role}`. El adaptador
copia identidad/datos y devuelve sobres profundamente congelados. Construye
exactamente `schemaVersion: 1`, UUID `eventId`, `timestamp` UTC ISO/RFC3339,
`gameId`, `gameVersion`, `matchId`, `type`, `data`, y `playerId` solo cuando se
proporciona un ID miembro de esta partida. No acepta identidad del plugin ni
campos extra en el descriptor de dominio. Rechaza tipos reservados, datos no JSON,
datos que no sean objetos, playerId ajenos/null y sobres que excedan 1 MiB UTF-8.
La regex SDK de type es `[A-Z][A-Z0-9_]{0,63}`; Go acepta tipos más amplios.

`MATCH_STARTED.data` combina el startData ya validado con
`players: prepared.players.map(p => p.id)`. No se envían objetos de participante
a GameStats. `players` e identidad no pueden sobrescribirse desde startData.
`MATCH_FINISHED.data` contiene `{reason}`; el motivo debe ser texto no vacío ni
solo espacios, hasta 128 caracteres y sin controles. Se conserva el formato v1
real de [GameStats](../../../gamestats/docs/events.md); no se cambia Go.

## EventSink: aceptación, rechazo y orden

La interfaz es **`eventSink.accept(event): void | Promise<void>`**. Resolver/retornar
sin excepción confirma aceptación local; arrojar/rechazar significa que el sink
**no retuvo ni entregó** el evento. No se usa un booleano de confirmación. El sink
debe preservar el orden de aceptación por partida; el manager espera cada
aceptación antes de continuar con la siguiente operación de esa partida.

El sink es un servicio confiable del host, no un objeto del plugin. Recibe un
sobre inmutable. Excepciones del sink se convierten en `EVENT_ACCEPTANCE_FAILED`,
sin propagar mensajes internos ni rutas. El manager no abre sockets y no consulta
resultados analíticos. No existe un sink silencioso por defecto que descarte los
eventos fingiendo haberlos aceptado.

La adaptación futura de EventOutbox no requiere reescribir esa clase:

```js
const eventSink = { accept(event) { outbox.enqueue(event); } };
```

Es una ilustración no conectada ni ejecutada en esta fase. `enqueue` confirma
inserción local, no recepción de Go. EventOutbox será responsable de entrega y
reintentos remotos en su integración posterior. Go seguirá validando/organizando
eventos; Scala seguirá calculando métricas cuando se consulten resultados. El
SDK no calcula estadísticas ni promete que aceptar un cierre dispare análisis.

Un sink que retiene/envía un evento y luego rechaza incumple esta interfaz: el
manager no puede deducir ese resultado ambiguo. Por tanto no se promete una única
entrega remota, persistencia, recuperación tras reinicio ni reconciliación de
fallos ambiguos. Los IDs estables en reintentos locales no convierten el 409 de Go
en una aceptación idempotente. Antes de conectar otro transporte deberá respetarse
esta frontera de aceptación definitiva.

## Estados y política de fallos

Todas las operaciones siguen pasando por la cola de esa instancia. Una espera
del sink no bloquea otra partida. Las operaciones encoladas verifican al ejecutar
que el registro no haya sido eliminado; no pueden resucitar una preparación.

| Operación | Confirmación y efecto de fallo |
| --- | --- |
| `create` | Conserva 2A: valida/prepara, registra prepared/version 0, sin eventos. Un fallo no registra sesión. |
| `activate` | Revalida lectura/snapshot, construye el inicio y espera aceptación. Solo entonces publica running/version 0. Sin hook ni llamada al plugin después de aceptar. |
| `activate` repetido en running | Devuelve reporte confirmado sin leer otra vez al plugin ni emitir otro inicio. En closing/finished rechaza por estado. |
| Fallo de activación | Devuelve ACTIVATION_FAILED con failureCode saneado; aborta/limpia y elimina la preparación, incluso si falla la limpieza. Nunca envía un cierre sin inicio aceptado. Un nuevo intento requiere create y otro UUID. |
| `discard` | Solo prepared: limpieza y eliminación sin eventos. Repetir tras eliminación da UNKNOWN_MATCH. Un fallo de limpieza no impide liberar el registro. |
| `finish` sin activación | Conserva 2A: limpieza, finished/version 1, sin eventos. Conserva reporte y cuota; repetir es idempotente. Para liberar una preparación se usa discard. |
| `finish` en running | Captura último reporte válido, bloquea el juego y limpia una vez. Construye un único cierre y espera su aceptación después del inicio. Si se acepta pasa a finished/version 1. |
| Rechazo local del cierre | Permanece closing con versión confirmada 0; señal abortada y operaciones del juego bloqueadas. No afirma estar finished. Conserva sobre de cierre completo para reintentar explícitamente con finish. |
| `finish` en closing | Reintenta exactamente el mismo eventId, timestamp, data y motivo original, sin releer ni repetir limpieza. Otro motivo en el reintento no sustituye el primero. |
| `finish` repetido en finished | Devuelve reporte terminal, sin nuevos eventos, versiones ni limpieza. |

`closing` es un estado pendiente bloqueado, no una transición final confirmada;
la versión solo avanza al confirmar el cierre. getSnapshot/list devuelven allí
el último reporte válido previo a limpieza, como en el reporte terminal de 2A.
Los registros activos, closing y finalizados conservan su cuota. Solo preparaciones
descartadas se eliminan; la cuota se libera al concluir el intento de limpieza.
Una limpieza que no termina retiene la operación y su cuota: no se añaden timeouts
en esta fase. El límite/reservas concurrentes sigue siendo 500.

Si falla la lectura final, se conserva el último snapshot válido; se limpia y se
intenta igualmente aceptar el cierre. Si falla la limpieza, la señal ya está
abortada y la sesión no permite más operaciones. También se intenta el cierre:
su aceptación confirma el fin de la partida, aunque no garantice liberación de
todos los recursos del plugin. Tras aceptarlo, finish rechaza con CLEANUP_FAILED
o INVALID_SNAPSHOT; getSnapshot muestra finished, y repetir finish no duplica nada.
No se reintentan efectos de limpieza del plugin automáticamente.

Si además falla el sink, prima EVENT_ACCEPTANCE_FAILED y queda closing. Los errores
de limpieza/lectura se conservan y se informan al aceptar el cierre en un intento
posterior. Ante fallo de activación, el error original se expresa como failureCode;
si falla también su limpieza, cleanupErrorCode es CLEANUP_FAILED. No se propagan
mensajes crudos, rutas o errores del plugin como motivo analítico de cierre.

## Contexto y frontera con 2B.2

El handle interno de fábrica añade `setLifecyclePhase(next)`, exclusivo del host:
prepared → activating → running; prepared/activating/running → closing; dispose
aborta y deja el contexto terminado. Las fases no se pueden modificar a través
del contexto congelado del plugin. La fachada interna bloquea dispatch/pause/resume
durante activating y después de closing/dispose. Se conserva su uso interno en
prepared para las pruebas de aislamiento de 2A; el manager no expone esos métodos.

Durante preparación, emitir o solicitar fin invalida la creación aunque el plugin
capture el error. Después, los tipos reservados producen RESERVED_EVENT; el resto
de emitEvent y finishMatch sigue arrojando EVENTS_UNAVAILABLE. Esto rige también
durante cierre/limpieza: un plugin no puede fabricar cierres o colarse detrás del
cierre del host. No se expone sink, outbox, HTTP, credenciales ni GameStats al plugin.
Los módulos confiables aún ejecutan en el proceso de Node, sin sandbox.

El adapter puede construir/validar un evento de dominio para el trabajo futuro,
pero el manager no ofrece publicación ni dispatch públicos. En esta fase los
únicos eventos aceptados por él son inicio y cierre. La futura publicación de
dominio deberá utilizar la misma cola antes del cierre, junto con el coordinador
de confirmaciones. No se implementan deduplicación de acciones, expectedVersion,
confirmaciones de dominio, finishMatch del plugin, pause/resume públicos, iframe,
bootstrap HTTP ni migraciones.

## Verificación aislada

`test/sdk-lifecycle.test.mjs` usa un MemorySink ficticio, fixtures y mocks locales;
comprueba sobres, permisos, rechazos, limpieza, cuota, orden y reintentos. Se corre
junto a las pruebas de 2A y de manifiestos. No se ejecutan Go/Scala, EventOutbox
real, red, Prolog o servidores. Esta evidencia verifica compatibilidad estructural
con el documento de eventos v1, no integración real ni cálculo de estadísticas.
