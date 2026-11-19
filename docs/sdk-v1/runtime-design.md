# Runtime SDK 1.0 — estado implementado y contrato objetivo

Este documento describe el runtime objetivo. La [Fase 2A](phase-2a.md) concreta e
implementa carga confiable, opciones, preparación y administración local de
sesiones preparadas. La [Fase 2B.1](phase-2b1.md) añade activación y cierre con un
EventSink local. La [Fase 2B.2A](phase-2b2a.md) implementa confirmaciones internas
de estado/versiones/eventos de dominio con celda optativa. Acciones públicas,
deduplicación y transporte real siguen siendo diseño para fases posteriores. El registro
continúa almacenando solo metadatos, separado del loader y la fábrica.
Las rutas HTTP, clases actuales, UI y EventOutbox mantienen su comportamiento.

## Plugin y sesión

El servidor del paquete exportará `default GamePlugin`, un objeto con:

```js
GamePlugin.initializationContract         // Declaración de participantes y datos de inicio
GamePlugin.createSession(context, options) // Promise<{session, startData}>

GameSession.getSnapshot()                 // Promise<GameData> (solo datos del juego)
GameSession.dispatch(action)              // Promise<OperationResult>
GameSession.finish({ reason })            // Promise<OperationResult>
GameSession.pause?.()                     // Promise<OperationResult>
GameSession.resume?.()                    // Promise<OperationResult>
```

El host esperará también resultados sincrónicos con `await`. Cada llamada a
`createSession` debe preparar una sesión nueva con estado de partida independiente.
`options` es la copia de valores ya validados contra el manifiesto. La fábrica
no crea identidades ni emite eventos de inicio/cierre. El host valida los exports
y la interfaz al cargar el módulo mediante el loader de 2A; discovery no lo hace.

El snapshot público será `{version, state, data}` más identidad. **GameConsole es
la única autoridad de `version` y `state`**: versión entera segura no negativa,
creciente por transición confirmada; estado `running`, `paused` o `finished`.
El plugin es la única autoridad de sus datos internos (`GameData`, objeto JSON),
como tablero, turno, puntuación o una decisión de IA pendiente. Su `getSnapshot`
devuelve una copia o representación inmutable de esos datos, sin mutarlos ni emitir eventos. El host compone
el sobre público, sin mantener otra copia mutable como motor de reglas. El plugin
no devuelve ni controla una segunda versión pública o un segundo ciclo de vida;
datos como `awaitingAI` no son un estado alternativo de la partida. Puede tener
revisiones internas, pero nunca sustituyen `expectedVersion` público.

`OperationResult` distingue `{outcome, committed, error?}`: `outcome` será
`completed`, `rejected` o `dependency_failed`; `committed` indica si hubo al menos
una transición confirmada. El host añade siempre el snapshot público vigente a
la respuesta, incluso ante fallo posterior a una confirmación. Las reglas de
confirmación y fallos se detallan abajo. Tamaños máximos, timeouts y traducción
HTTP de errores se fijarán antes de integrar el runtime; no son garantías del
servidor actual.

`finish` liberará timers y recursos del plugin y será idempotente. `pause` y
`resume` existirán juntos solo si ambas capacidades son verdaderas; una repetición
en el estado destino no producirá otra transición. Tras finalizar no se permiten
acciones ni reanudación. La pérdida de foco del navegador será una política del
host futuro; no se deduce de `capabilities` ni se implementa aquí. El host solicita
estas operaciones y confirma sus transiciones; el plugin solo pausa/reanuda sus
recursos o limpia su estado. Terminar por reglas se solicita con `finishMatch`.

## Preparación y activación de una sesión

Protocolo objetivo obligatorio. Los pasos de preparación y validación están
implementados en 2A según el descriptor exacto de [phase-2a.md](phase-2a.md); la
construcción de MATCH_STARTED y la activación local del paso 5 se implementan en
2B.1. En 2B.2A se permite dominio mediante operaciones internas coordinadas. La
entrega real a Go y habilitación de acciones públicas siguen pendientes:

1. El host valida opciones, asigna identidad y valida participantes contra
   `manifest.players` y `GamePlugin.initializationContract`. Esta declaración del
   paquete especificará IDs/roles permitidos y requeridos y los campos requeridos
   de `startData` con tipos y restricciones. El host la inspeccionará genéricamente,
   sin condicionales por `gameId`. No se añade este descriptor a `game.json` ahora.
2. El host llama a `createSession(context, options)` con participantes validados y
   contexto en modo preparación. El plugin prepara todos sus datos iniciales y
   devuelve `{session, startData}`. No inicia timers, acepta acciones ni llama a
   `emitEvent` o `finishMatch`; el host rechaza esas llamadas durante preparación.
3. El host verifica la interfaz, obtiene el `GameData` inicial y valida que
   `startData` sea JSON y cumpla el contrato requerido del juego. Revalida cantidad,
   unicidad, IDs y roles de participantes; todo `playerId` referido debe pertenecer
   al contexto. Campos como dificultad, símbolos o tamaño deben ser consistentes
   con opciones y participantes. No basta con comprobar que exista un objeto.
4. El host construye `MATCH_STARTED.data = {players: context.players.map(p => p.id), ...startData}`.
   `players` y la identidad son reservados: se rechaza `startData` que intente
   sustituirlos. Los objetos internos `{id,role}` no cambian el arreglo de IDs del
   contrato GameStats v1. Solo el host asigna el sobre del evento. Para el futuro Gato,
   por ejemplo, se exigirán human/prolog y sus símbolos; para Snake, `gridSize`
   compatible con la opción discreta. Estas son obligaciones de sus contratos,
   no validaciones por ID codificadas en el host ni migraciones actuales.
5. Solo cuando el inicio se acepte en la cola local, el host publica la instancia
   en `running`, versión pública inicial `0`, y habilita acciones y eventos de
   dominio. La primera transición posterior confirmada incrementa la versión.
   El transporte remoto no tiene que haber entregado el evento para habilitarla.
   En 2B.1 solo se habilita el ciclo de vida running; las acciones y eventos de
   dominio permanecían deshabilitados. 2B.2A permite únicamente operaciones
   internas con confirmación explícita; no habilita dispatch público.

Cualquier fallo antes de aceptar el inicio impide publicar la instancia y emitir
eventos de dominio; el host limpia la sesión preparada con `finish` en modo de
cancelación, sin generar MATCH_FINISHED para una partida que nunca inició. Una
vez aceptado MATCH_STARTED, un fallo de activación debe comunicarse como fallo
de una partida iniciada y cerrarse explícitamente si es irrecuperable; no se borra
el inicio. No hay un hook automático de activación implementado: cuando un juego
necesite timers se definirá su arranque después de esta barrera, nunca en fábrica.

## GameContext e identidad

El host inyectará un contexto por partida:

| Miembro conceptual | Responsabilidad |
| --- | --- |
| `gameId`, `gameVersion`, `matchId`, `players` | Identidad y participantes asignados/validados por el host, inmutables; nunca proceden de acciones sin validar. |
| `createState(initialData)` | Optativo en 2B.2A: celda JSON inmutable con read(), creada una vez durante preparación. El plugin decide reglas y datos; el host coordina su reemplazo. |
| `confirmTransition({data,events})` | 2B.2A: valida candidato y eventos, espera aceptación local y confirma versión. Solo dentro de una operación interna running. |
| `emitEvent({type,data,playerId?})` | Conservado como guardia, no publica independientemente. Los eventos de dominio se incluyen en confirmTransition para no separarlos del estado. |
| `finishMatch({reason})` | Dentro de una operación, Promise de recepción de intención; el cierre se procesa al salir sin espera recursiva. No permite fabricar MATCH_FINISHED. data adicional queda pendiente. |
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
- `type`: token ASCII `[A-Z][A-Z0-9_]{0,63}`, convención estable UPPER_SNAKE_CASE
  definida por el plugin (por ejemplo `PLACE_MARK`, `CHANGE_DIRECTION`, `RETRY_AI`).
- `payload`: objeto JSON, validación de reglas específica del plugin; nunca código.
- `expectedVersion`: entero seguro no negativo opcional. Si difiere del snapshot
  actual, el host rechazará antes de ejecutar la acción, sin emitir eventos.

Los nombres se interpretan **dentro de la instancia destinataria**: dos plugins
pueden usar `MOVE` con payloads distintos. El host valida el sobre, el estado y la
versión, y entrega `type`/`payload` al plugin; no mantiene una lista de acciones ni
decide su significado. El plugin valida el nombre conocido y su payload. Cambiar
el significado de un nombre requiere versionar el contrato del juego. Pausar,
reanudar y finalizar siguen siendo operaciones de ciclo de vida del host; un
nombre de acción no permite eludir esa autoridad.

El host serializará operaciones por partida; las otras partidas no compartirán
esa cola. Para un ID repetido con el mismo contenido devolverá el resultado ya
aceptado sin volver a ejecutar; con contenido diferente rechazará por conflicto.
Esto incluye resultados `dependency_failed` con cambios confirmados: repetir el
mismo requestId no repite la jugada humana ni los eventos. Para recuperar una
decisión pendiente se usa una acción explícita del plugin con otro requestId.
La ventana y límite de esa deduplicación deberán especificarse al implementar
el runtime; no se promete persistencia después de reiniciar. El plugin validará
la legalidad de la acción. Ni `requestId` ni `expectedVersion` reemplazan control
de acceso o titularidad de partida, que sigue fuera de esta fase.

## Confirmación de transiciones y fallos externos

Una acción inválida (nombre/payload ilegal, versión incorrecta o prohibición por
reglas) devuelve `outcome: rejected, committed: false`: sin mutaciones, eventos
ni avance de versión. El plugin debe validarla antes de cambiar sus datos.

Una operación válida puede contener más de una transición confirmada. Cada punto
de confirmación coordina los datos del plugin y la aceptación local de sus eventos
con el host, bajo la exclusión de esa instancia. El host valida los eventos antes
de confirmarlos y asigna la siguiente versión pública; una consulta no debe ver
datos de una transición como confirmados con la versión anterior. El plugin no
puede enviar eventos desvinculados de una transición ni fabricar versiones.
También puede confirmarse una transición sin eventos. El mecanismo concreto de
esta coordinación se implementa en 2B.2A con candidatos inmutables y aceptación
local, incluidos lotes opcionales. No es una API de transacciones durables.

Después de una confirmación, un fallo de una dependencia no deshace los datos ni
retira eventos ya aceptados. Se devuelve `outcome: dependency_failed`, `committed:
true`, un error saneado y recuperable cuando corresponda, y el snapshot con la
versión vigente. Si no hubo confirmación, `committed` es false y el snapshot sigue
sin cambios. No se presenta una transición confirmada como acción rechazada ni
se oculta detrás de un error sin estado. La respuesta HTTP concreta queda futura.

Ejemplo de contrato para Gato: validar la casilla → confirmar jugada humana,
MOVE_PLACED y datos con IA pendiente → consultar Prolog. Si Prolog falla, tablero
y evento humano permanecen confirmados y visibles; la partida puede seguir
`running` con `data.awaitingAI: true`. Una acción `RETRY_AI` con requestId nuevo
recupera ese trabajo sin colocar otra ficha humana. Una respuesta válida de IA
será otra transición confirmada con una versión posterior. Es una descripción de
compatibilidad con el comportamiento existente, no una migración del juego.

El host conserva las confirmaciones al construir la respuesta, incluso si el
plugin lanza inesperadamente después de ellas: captura el error, consulta los
datos confirmados y comunica el snapshot vigente. Un plugin que muta sin informar
una confirmación incumple el contrato; el runtime deberá diagnosticarlo y evitar
seguir aceptando acciones incoherentes. No se promete deshacer efectos externos,
recuperación durable ni atomicidad frente a caída del proceso.

## Ciclo de vida y eventos: el host es propietario

Diseño de estados: preparación interna → running ↔ paused → finished. Solo el
host coordina transiciones y el cierre idempotente, usando el protocolo de
activación anterior. Una fábrica fallida no publica partida ni MATCH_STARTED.
Una sesión terminada no acepta más eventos de dominio.

El host es el **único emisor de MATCH_STARTED y MATCH_FINISHED**. `emitEvent`
rechazará ambos tipos reservados. El plugin solo emite hechos propios de sus
reglas, por ejemplo incrementos de puntos, y solicita terminar mediante
`finishMatch`. La solicitud de término durante `dispatch` se coordinará al salir
de la operación para no esperar recursivamente la misma cola; la limpieza
`session.finish` no volverá a llamar a `finishMatch`. El protocolo detallado de
errores de limpieza y aceptación de eventos de ciclo de vida se implementa en
2B.1, y el cierre solicitado desde operación se coordina en 2B.2A.

El Adapter de 2B.1 construye el sobre existente de GameStats sin cambiarlo:
`schemaVersion: 1`, `eventId`, `timestamp`, `gameId`, `matchId`, `type`, `data`,
y opcionalmente `playerId` (el SDK incluye `gameVersion`). El host asigna ID de evento,
tiempo UTC e identidad y conserva orden por partida. La entrega/reintentos mediante
EventOutbox siguen pendientes: por ahora solo se prueba un EventSink en memoria.
Varios eventos de una misma transición requieren acceptBatch de lote completo,
según [2B.2A](phase-2b2a.md); accept individual no ofrece esa garantía.
No se envía el acumulado como si fuera incremento. Aceptación local
no equivale a entrega exactamente una vez; no se añade persistencia durable.

Go seguirá validando y organizando eventos; Scala seguirá calculando estadísticas.
El perfil opcional del paquete no instala código Scala, no modifica contratos de
Go y no garantiza métricas para un juego nuevo. Las consultas a resultados y al
resumen pasarán por una fachada del host, pendiente de diseño e integración.

## Web y límites v1

El entrypoint web `.html` identifica una página independiente del plugin,
destinada a un iframe futuro. La página puede importar módulos ESM propios y es
responsable de UI y visualización. No hay todavía iframe implementado, bridge de
mensajes, protocolo de montaje/desmontaje ni aislamiento entre vistas. Antes de
integrarla se decidirán los permisos del iframe, origen, recursos permitidos y
validación de mensajes. Elegir HTML no constituye una garantía de sandbox. El
registro no sirve archivos ni transforma rutas locales en URLs públicas.

v1 no incluye instalación remota, hot reload, resolución de dependencias de
paquetes, scripts de instalación, marketplace, persistencia, autenticación ni
multijugador remoto. El soporte de N manifiestos no cambia el requisito de
entregar exactamente tres juegos funcionales. Los fixtures quedan fuera de
`plugins/` y no deben empaquetarse como juegos de producción.

## Patrones y razones

| Patrón | Decisión | Estado en esta fase |
| --- | --- | --- |
| Registry + Factory | El registro descubre identidades y metadatos sin condiciones por `gameId`; una fábrica separada prepara cada sesión. Evita acoplar catálogo y reglas. | Registry, Loader y preparación de Factory implementados en 2A. |
| Adapter | Construye el sobre GameStats v1 y centraliza identidad/tiempo, sin llevar estadísticas a JS. | Ciclo de vida en 2B.1; publicación interna coordinada de dominio en 2B.2A. Conexión EventOutbox pendiente. |
| Observer | El host observa hechos emitidos por la sesión y desacopla reglas de consumidores como transporte o UI. | Futuro; sin bus nuevo. |
| State | Ciclo de vida centralizado y confirmación explícita para evitar autoridades contradictorias. | prepared/running/closing/finished y coordinación interna de dominio implementados; pausa pública pendiente. Ninguna clase actual se reescribe. |
| Dependency Injection | Contexto y servicios por sesión permiten límites explícitos y sustituciones en pruebas. | Contexto mínimo, celda optativa y sink inyectable implementados; servicios externos y transporte real pendientes. |
| Facade | Una interfaz del host para catálogo, sesiones y consultas GameStats evita que web/plugins coordinen servicios internos. | Catálogo y manager de preparación/lectura/cierre implementados; integración GameStats futura. |

La siguiente fase deberá revisar primero carga confiable, fábrica, coordinación
de cierre, cuotas y errores, y después migrar un juego de forma incremental.
No se debe sustituir el catálogo HTTP solo porque el registro ya existe.
