# Runtime SDK 1.0 — contrato diseñado, pendiente de implementación

Todo lo descrito aquí es diseño para fases posteriores. El registro actual
almacena metadatos; no resuelve fábricas, crea sesiones ni adapta eventos.
Las rutas HTTP, clases actuales, UI y EventOutbox mantienen su comportamiento.

## Plugin y sesión

El servidor del paquete exportará `default GamePlugin`, un objeto con:

```js
GamePlugin.createSession(context, options) // Promise<GameSession>

GameSession.getSnapshot()                 // Promise<Snapshot>
GameSession.dispatch(action)              // Promise<Snapshot>
GameSession.finish({ reason })            // Promise<Snapshot>
GameSession.pause?.()                     // Promise<Snapshot>
GameSession.resume?.()                    // Promise<Snapshot>
```

El host esperará también resultados sincrónicos con `await`. Cada llamada a
`createSession` debe devolver un objeto nuevo con estado de partida independiente.
`options` es la copia de valores ya validados contra el manifiesto. La fábrica
no crea identidades ni emite eventos de inicio/cierre. El host valida los exports
y la interfaz al cargar el módulo en una fase futura; discovery no lo hace.

Un `Snapshot` será un objeto JSON defensivo `{version, state, data}`: `version`
entero seguro no negativo y creciente por transición aceptada, `state` uno de
`running`, `paused`, `finished`, `data` objeto propio del juego. `getSnapshot` no
mutará el juego ni emitirá eventos. El host añadirá identidad al sobre de API.
Las operaciones mutadoras devolverán el snapshot resultante; un rechazo no debe
dejar cambios parciales. Tamaños máximos, timeouts y traducción HTTP de errores
se fijarán antes de integrar el runtime; no son garantías del servidor actual.

`finish` liberará timers y recursos del plugin y será idempotente. `pause` y
`resume` existirán juntos solo si ambas capacidades son verdaderas; una repetición
en el estado destino no producirá otra transición. Tras finalizar no se permiten
acciones ni reanudación. La pérdida de foco del navegador será una política del
host futuro; no se deduce de `capabilities` ni se implementa aquí.

## GameContext e identidad

El host inyectará un contexto por partida:

| Miembro conceptual | Responsabilidad |
| --- | --- |
| `gameId`, `gameVersion`, `matchId`, `players` | Identidad y participantes asignados/validados por el host, inmutables; nunca proceden de acciones sin validar. |
| `emitEvent({type,data,playerId?})` | Promise de aceptación local de un evento de dominio, sin promesa de entrega remota. El host valida tipo/datos y autoría del participante. |
| `finishMatch({reason,data?})` | Promise que solicita cierre al coordinador del host, una sola vez. No sustituye ni permite fabricar MATCH_FINISHED desde el plugin. |
| `logger` | Fachada `debug/info/warn/error(message, fields?)` contextualizada por partida; sin credenciales ni datos sensibles. |
| `signal` | `AbortSignal` para cancelación y limpieza; no equivale a una pausa. |
| `services` | Objeto de servicios expresamente autorizados por el host para ese plugin. Sin credenciales globales ni objetos de servidor. |

Una eventual fachada de IA/Prolog se inyectará solo con autorización explícita;
declarar `ai: true` no basta. La forma exacta de cada servicio se acordará antes
de migrar un juego. `GameContext` no entregará acceso directo a EventOutbox,
HTTP de GameStats, módulos Go/Scala ni cálculo agregado de estadísticas.
Esta inyección es una frontera de diseño, no aislamiento de seguridad: un módulo
Node ejecutado en proceso puede usar APIs de Node. No se promete sandbox v1.

## Acciones y concurrencia

El protocolo futuro será `{requestId,type,payload,expectedVersion?}`:

- `requestId`: string no vacío de hasta 128 caracteres, sin controles; único por
  operación lógica dentro de una partida. Un reintento usa el mismo ID.
- `type`: token ASCII `[A-Z][A-Z0-9_]{0,63}`, definido por el plugin.
- `payload`: objeto JSON, validación de reglas específica del plugin; nunca código.
- `expectedVersion`: entero seguro no negativo opcional. Si difiere del snapshot
  actual, el host rechazará antes de ejecutar la acción, sin emitir eventos.

El host serializará operaciones por partida; las otras partidas no compartirán
esa cola. Para un ID repetido con el mismo contenido devolverá el resultado ya
aceptado sin volver a ejecutar; con contenido diferente rechazará por conflicto.
La ventana y límite de esa deduplicación deberán especificarse al implementar
el runtime; no se promete persistencia después de reiniciar. El plugin validará
la legalidad de la acción. Ni `requestId` ni `expectedVersion` reemplazan control
de acceso o titularidad de partida, que sigue fuera de esta fase.

## Ciclo de vida y eventos: el host es propietario

Diseño de estados: creación interna → running ↔ paused → finished. Solo el host
coordina transiciones y el cierre idempotente. Una fábrica fallida no publica
partida ni MATCH_STARTED. El inicio se acepta en la cola local antes de habilitar
dispatch; una sesión terminada no acepta más eventos de dominio.

El host es el **único emisor de MATCH_STARTED y MATCH_FINISHED**. `emitEvent`
rechazará ambos tipos reservados. El plugin solo emite hechos propios de sus
reglas, por ejemplo incrementos de puntos, y solicita terminar mediante
`finishMatch`. La solicitud de término durante `dispatch` se coordinará al salir
de la operación para no esperar recursivamente la misma cola; la limpieza
`session.finish` no volverá a llamar a `finishMatch`. El protocolo detallado de
errores de limpieza y aceptación de eventos queda por implementar con el runtime.

Un Adapter futuro construirá el sobre existente de GameStats sin cambiarlo:
`schemaVersion: 1`, `eventId`, `timestamp`, `gameId`, `matchId`, `type`, `data`,
y opcionalmente `gameVersion`, `playerId`. El host asignará ID de evento, tiempo
UTC e identidad, conservará orden por partida y delegará entrega/reintentos en
EventOutbox. No se envía el acumulado como si fuera incremento. Aceptación local
no equivale a entrega exactamente una vez; no se añade persistencia durable.

Go seguirá validando y organizando eventos; Scala seguirá calculando estadísticas.
El perfil opcional del paquete no instala código Scala, no modifica contratos de
Go y no garantiza métricas para un juego nuevo. Las consultas a resultados y al
resumen pasarán por una fachada del host, pendiente de diseño e integración.

## Web y límites v1

El entrypoint web `.mjs` identifica el futuro módulo de presentación del plugin;
la UI y las reglas de visualización serán su responsabilidad. No hay todavía
interfaz web normativa de montaje/desmontaje, bridge de mensajes, iframe ni
aislamiento entre vistas. Antes de implementar esa parte se decidirán esos
contratos y la política de recursos web, origen y permisos. El registro no sirve
archivos ni transforma rutas locales en URLs públicas.

v1 no incluye instalación remota, hot reload, resolución de dependencias de
paquetes, scripts de instalación, marketplace, persistencia, autenticación ni
multijugador remoto. El soporte de N manifiestos no cambia el requisito de
entregar exactamente tres juegos funcionales. Los fixtures quedan fuera de
`plugins/` y no deben empaquetarse como juegos de producción.

## Patrones y razones

| Patrón | Decisión | Estado en esta fase |
| --- | --- | --- |
| Registry + Factory | El registro descubre identidades y metadatos sin condiciones por `gameId`; una fábrica separada creará cada sesión. Evita acoplar catálogo y reglas. | Registry implementado; Factory diseñada. |
| Adapter | Convierte hechos de dominio al sobre GameStats v1 y centraliza identidad/tiempo, sin llevar estadísticas a JS. | Futuro; no se modifica EventOutbox. |
| Observer | El host observa hechos emitidos por la sesión y desacopla reglas de consumidores como transporte o UI. | Futuro; sin bus nuevo. |
| State | Ciclo running/paused/finished centralizado para evitar que cada plugin redefina transiciones comunes. | Futuro; ninguna clase actual se reescribe. |
| Dependency Injection | Contexto y servicios por sesión permiten límites explícitos y sustituciones en pruebas. | Futuro. |
| Facade | Una interfaz del host para catálogo, sesiones y consultas GameStats evita que web/plugins coordinen servicios internos. | Futuro, salvo las operaciones de catálogo del registro. |

La siguiente fase deberá revisar primero carga confiable, fábrica, coordinación
de cierre, cuotas y errores, y después migrar un juego de forma incremental.
No se debe sustituir el catálogo HTTP solo porque el registro ya existe.
