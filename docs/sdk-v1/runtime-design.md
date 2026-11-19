# Runtime SDK 1.0 — contrato diseñado, pendiente de implementación

Todo lo descrito aquí es diseño para fases posteriores. El registro actual
almacena metadatos; no resuelve fábricas, crea sesiones ni adapta eventos.
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
y la interfaz al cargar el módulo en una fase futura; discovery no lo hace.

El snapshot público será `{version, state, data}` más identidad. **GameConsole es
la única autoridad de `version` y `state`**: versión entera segura no negativa,
creciente por transición confirmada; estado `running`, `paused` o `finished`.
El plugin es la única autoridad de sus datos internos (`GameData`, objeto JSON),
como tablero, turno, puntuación o una decisión de IA pendiente. Su `getSnapshot`
devuelve una copia de esos datos, sin mutarlos ni emitir eventos. El host compone
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

Protocolo futuro obligatorio, sin implementación en esta revisión:

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
4. El host construye `MATCH_STARTED.data = {players: context.players, ...startData}`.
   `players` y la identidad son reservados: se rechaza `startData` que intente
   sustituirlos. Solo el host asigna el sobre del evento. Para el futuro Gato,
   por ejemplo, se exigirán human/prolog y sus símbolos; para Snake, `gridSize`
   compatible con la opción discreta. Estas son obligaciones de sus contratos,
   no validaciones por ID codificadas en el host ni migraciones actuales.
5. Solo cuando el inicio se acepte en la cola local, el host publica la instancia
   en `running`, versión pública inicial `0`, y habilita acciones y eventos de
   dominio. La primera transición posterior confirmada incrementa la versión.
   El transporte remoto no tiene que haber entregado el evento para habilitarla.

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
| `emitEvent({type,data,playerId?})` | Promise de aceptación local de un evento de dominio, sin promesa de entrega remota. El host valida tipo/datos y autoría del participante; solo se permite después de activar la sesión y como parte de una transición coordinada. |
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
esta coordinación se especificará al implementar el runtime; no se añade ahora
una API de transacciones o persistencia.

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
| Registry + Factory | El registro descubre identidades y metadatos sin condiciones por `gameId`; una fábrica separada creará cada sesión. Evita acoplar catálogo y reglas. | Registry implementado; Factory diseñada. |
| Adapter | Convierte hechos de dominio al sobre GameStats v1 y centraliza identidad/tiempo, sin llevar estadísticas a JS. | Futuro; no se modifica EventOutbox. |
| Observer | El host observa hechos emitidos por la sesión y desacopla reglas de consumidores como transporte o UI. | Futuro; sin bus nuevo. |
| State | Ciclo running/paused/finished centralizado para evitar que cada plugin redefina transiciones comunes. | Futuro; ninguna clase actual se reescribe. |
| Dependency Injection | Contexto y servicios por sesión permiten límites explícitos y sustituciones en pruebas. | Futuro. |
| Facade | Una interfaz del host para catálogo, sesiones y consultas GameStats evita que web/plugins coordinen servicios internos. | Futuro, salvo las operaciones de catálogo del registro. |

La siguiente fase deberá revisar primero carga confiable, fábrica, coordinación
de cierre, cuotas y errores, y después migrar un juego de forma incremental.
No se debe sustituir el catálogo HTTP solo porque el registro ya existe.
