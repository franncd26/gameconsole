# Fase 2B.2A — protocolo de confirmación local

> **Informe histórico de etapa.** Los alcances, comandos y verificaciones siguientes
> corresponden a esta fase; no son la guía de despliegue vigente. Consultar el
> [README principal](../../README.md) y el [estado de entrega](../entrega.md).

Esta referencia conserva el protocolo y las correcciones auditadas de 2B.2A. La
[Fase 2B.2B](phase-2b2b.md) añade la fachada JSON dispatch y concreta expectedVersion
e historial de requestId, reutilizando este coordinador sin alterar confirmaciones,
acceptBatch ni cierre condicionado al éxito.
La [Fase 3A](phase-3a.md) concreta la aceptación local de lotes en EventOutbox y
su adaptador, sin prometer atomicidad remota ni integración Go/Scala verificada.

## Correcciones de auditoría: cierre condicionado y una confirmación pendiente

El cierre automático anterior atendía toda intención registrada sin comprobar el
resultado final de la operación; podía emitir MATCH_FINISHED después de rechazar
una transición. Ahora solo se ejecuta si la operación termina sin errores ni
confirmaciones rechazadas y su resultado no es rejected ni dependency_failed.
Una intención registrada no confirma por sí sola el fin de la partida.

La secuencia interna anterior ordenaba propuestas ya calculadas, pero no impedía
que dos usaran el mismo estado anterior. Ahora solo se permite una confirmación
pendiente por operación. Una segunda se rechaza con CONCURRENT_TRANSITION antes
de validarla/enviarla, y el fallo queda registrado aunque el plugin lo capture.
La primera puede terminar y confirmarse; no se revierte ni cancela un evento ya
aceptado. El fallo bloquea más confirmaciones y el cierre automático de esa
operación. Otra operación explícita puede continuar desde el estado vigente.

## Decisión previa a la implementación

`EventSink.accept(event)` de 2B.1 no permite aceptar atómicamente dos eventos:
si acepta el primero y rechaza el segundo ya existe un prefijo irreversible.
No se implementará un bucle que lo presente como una transacción. Se añade una
capacidad opcional mínima `acceptBatch(events): void | Promise<void>`: aceptar
todo el lote localmente o rechazar sin retener/entregar ninguno. No se puede
simular esa capacidad llamando varias veces a accept. El SDK no puede verificar
la honestidad de un sink; la garantía depende de ese contrato inyectable.

Una transición con cero eventos no llama al sink; con uno usa accept; con varios
requiere acceptBatch antes de enviar cualquiera. Se preservan los sinks y los
eventos de ciclo de vida de 2B.1. No se modifica EventOutbox ni se afirma que pueda
aceptar lotes atómicos. Su adaptación futura necesitaría un buffer local capaz de
insertar el lote completo antes de drenar a EventOutbox; no bastaría un wrapper
secuencial. Ese buffer/transporte no se implementa aquí.

Tampoco es seguro aceptar eventos y después ejecutar un callback arbitrario del
plugin para mutar el estado: ese callback podría fallar. El mecanismo elegido es
una **celda de estado JSON optativa**, creada durante preparación. El plugin define
su estructura, reglas y valores; la celda solo controla el reemplazo coordinado de
la referencia. No hay un segundo motor de reglas ni una copia mutable paralela.

## Protocolo elegido

1. En preparación, el plugin llama una sola vez a `context.createState(initialData)`
   y conserva el objeto `{read()}` devuelto. read devuelve el estado confirmado
   profundamente congelado. `getSnapshot()` devuelve ese estado. Los plugins que
   no opten por esta celda siguen funcionando con el contrato previo, pero no pueden
   usar el nuevo coordinador de transiciones.
2. Dentro de una operación interna del host, el plugin valida la acción y calcula
   un candidato nuevo sin mutar el estado confirmado. Una acción inválida devuelve
   un resultado rejected o lanza antes de solicitar una confirmación: no cambia la
   celda, la versión ni los eventos.
3. Solicita `await context.confirmTransition({data, events})`. events es un arreglo
   explícito de 0–32 descriptores `{type,data,playerId?}`. No existe publicación de
   eventos de dominio independiente de esta confirmación.
4. El host copia/congela el candidato, comprueba el snapshot público resultante y
   todos los sobres mediante GameEventAdapter, incluyendo tipo, miembros, tipos
   reservados y tamaño de 1 MiB por sobre. Valida running y disponibilidad del sink.
5. Espera aceptación local del evento o lote. Un rechazo deja celda y versión
   intactas y, bajo el contrato del sink, no deja eventos aceptados. Una aceptación
   sustituye la referencia de datos y aumenta la versión pública exactamente una
   vez, sin await ni callback del plugin entre ambas asignaciones. Devuelve un
   recibo con versión y snapshot defensivo. Cero eventos también confirma versión.
6. El plugin puede realizar otra confirmación o consultar una dependencia. Si esa
   dependencia falla después del recibo, las confirmaciones anteriores permanecen;
   el resultado de la operación incluye error saneado y snapshot vigente. Continuar
   exige otra operación explícita que lea el estado pendiente, sin repetir lo ya
   confirmado. Una intención de cierre queda cancelada si la operación falla;
   la partida permanece running. No hay rollback implícito ni deduplicación de
   acciones todavía.

El host ejecutará la operación por la cola de la partida mediante una entrada
interna para código confiable, no un endpoint dispatch. Dentro de la operación,
las confirmaciones tienen su propia secuencia directa y como máximo una pendiente:
no esperan recursivamente la cola exterior. Una solicitud `context.finishMatch({reason})` solo registra una
intención y confirma esa recepción; el cierre real se procesa al salir de la
operación, después de drenar la confirmación pendiente y comprobar su éxito.
Si hay errores o resultado rejected/dependency_failed, se descarta la intención
sin generar MATCH_FINISHED ni limpiar la sesión. No espera su propia operación.

Las confirmaciones de una operación se detienen al primer error, incluso si el
plugin lo captura. Una operación puede tener un prefijo de **transiciones** ya
confirmadas; una transición de varios eventos requiere un lote completo. No son
la misma garantía. Las partidas usan colas independientes.

## Alcance de la garantía

Los snapshots públicos no muestran candidato ni datos confirmados con una versión
vieja. No hay atomicidad global observable simultáneamente entre memoria y sink:
el sink acepta antes del cambio de referencia, y una caída en esa ventana puede
dejar eventos sin estado recuperable. No hay persistencia, transacciones durables,
exactamente una entrega, transporte real a Go o cálculo nuevo en Scala.

La aceptación local tampoco prueba que Go haya recibido nada. Go mantiene su
sobre/ciclo de vida v1 y Scala sus cálculos. HTTP, web, juegos históricos, Prolog,
EventOutbox, deduplicación completa, expectedVersion y dispatch público quedan
fuera de esta fase. Los módulos siguen siendo instalados/confiables, sin sandbox.

## Interfaces implementadas

```js
// Plugin: createSession(context, options), durante preparación
const state = context.createState({ board: [], awaitingAI: false });
// session.getSnapshot: () => state.read()

// Plugin: dentro de su operación, después de validar reglas
const receipt = await context.confirmTransition({
  data: { board: ['X'], awaitingAI: true }, // reemplazo completo, no patch
  events: [{ type: 'MOVE_PLACED', data: { symbol: 'X' }, playerId: 'human' }]
});
// receipt = {version, snapshot}; snapshot es defensivo
await context.finishMatch({ reason: 'completed' }); // {requested:true}, no espera el cierre

// Host confiable o pruebas; no se acepta código desde HTTP
const result = await manager.runOperation(matchId, session => session.dispatch(action));
```

`runOperation` es una entrada interna de coordinación con callback del host, sin
un protocolo público de acciones. No acepta requestId ni expectedVersion, no
autentica clientes y no deduplica solicitudes. `action` es aquí un dato del fixture,
no un sobre HTTP. El manager entrega solo la fachada de métodos de la sesión;
el plugin recibe la capacidad de confirmar mediante su contexto. Ninguno recibe
el sink, el adapter, el Map ni el reemplazador interno de estado.

`createState(initialData)` solo se puede usar una vez y en preparación, con un
objeto JSON. La celda copia/congela el valor inicial; `getSnapshot()` inicial debe
coincidir con él. Desde entonces los snapshots del host leen esa celda canónica,
sin otra copia mutable de dominio ni llamadas al plugin después de aceptar un
evento. `read()` devuelve la referencia inmutable, por lo que un valor leído antes
de confirmar no se actualiza mágicamente: el plugin debe volver a leer. Se debe
esperar cada recibo antes de derivar otro candidato del estado actualizado. El host
rechaza una segunda solicitud mientras la primera está pendiente, incluso si
ambas se hacen inmediatamente, antes de que el sink reciba la primera. El indicador
de pendiente se libera al completarse/rechazarse la promesa, antes de entregar su
resultado al plugin. No hay mezcla automática de candidatos paralelos ni reglas de juego en JS
del anfitrión. Las opciones, identidad y participantes mantienen las protecciones
de 2A; los campos del sobre de identidad nunca se toman del candidato. Un campo
homónimo dentro de data no sustituye la identidad asignada por el anfitrión.

Los handles internos añaden `hasCoordinatedState`, `stageTransition(data)`,
`publishTransition(candidate)` y `withOperation(bridge, execute)`. Son privados
por alcance de composición del host, no APIs del plugin/web. publishTransition
solo cambia una referencia ya validada/congelada y no llama código del plugin.
La autorización de módulos confiables sigue siendo necesaria; no es un sandbox.

El resultado de runOperation es JSON defensivo:

```js
{
  outcome: 'completed', // o rejected/dependency_failed
  committed: true,      // al menos una confirmación de dominio, no cuenta cierre
  confirmations: 1,
  snapshot: { /* identidad, state, version, players, options, startData, data */ },
  error: { code, message } // solo si hubo error; mensajes saneados
}
```

El valor `committed` declarado por un plugin se ignora: lo calcula el host. El
callback puede devolver `undefined` o un objeto cuyo outcome sea completed,
rejected o dependency_failed; sus datos/error internos no se publican. La
representación debe ser JSON, sin accesores ni funciones; un resultado incompatible
produce INVALID_OPERATION_RESULT, conservando cualquier confirmación anterior. La
clasificación genérica de una excepción es PLUGIN_OPERATION_FAILED (no se intenta
inferir si era Prolog u otro servicio). Si el plugin declara rejected después de
confirmar, se informa INVALID_OPERATION_RESULT y se conserva lo confirmado.
Una acción inválida debe retornar rejected **antes** de confirmar. Si antes había
registrado una intención de fin, ese resultado la cancela: no es un cierre confirmado.

Un fallo de validación/sink sin confirmaciones produce rejected/committed false.
Si ya hubo confirmaciones, el fallo produce dependency_failed/committed true.
Una excepción de la operación o un outcome dependency_failed también informa
fallo y conserva el snapshot vigente, incluso con cero confirmaciones. Los errores
capturados por el plugin al confirmar no se ocultan: detienen nuevas confirmaciones
de esa operación. Otra operación explícita puede intentar continuar. Nunca se
reintenta la acción completa de manera implícita.

## Secuenciación, cierre y compatibilidad

Las operaciones usan la cola por instancia de 2A/2B.1. Dentro de una operación las
confirmaciones pasan por una secuencia interna, con una sola confirmación pendiente;
las propuestas admitidas se copian al recibirlas. Las segundas solicitudes
simultáneas no se encolan. El host drena también una confirmación única enviada
sin await antes de resolver la operación; esto no habilita enviar otra sin esperar
la anterior. Varias confirmaciones secuenciales correctamente esperadas siguen
siendo válidas. No se habilitan timers o publicaciones espontáneas:
AsyncLocalStorage vincula confirmaciones/solicitudes de fin al alcance activo de
esa operación. Un contexto asíncrono que sobrevive a ella pierde esa capacidad.

No se llama recursivamente a la cola principal para confirmar o cerrar. Un intento
del callback de esperar `manager.getSnapshot/finish/runOperation` de su misma
partida se rechaza con REENTRANT_OPERATION. Debe usar el recibo de confirmación y
`context.finishMatch` para esos propósitos. Las otras partidas tienen colas
independientes. Los snapshots externos de la misma partida esperan a que termine
la operación, incluso si se está esperando una dependencia externa.

La primera solicitud de cierre guarda el motivo; solicitudes posteriores no lo
sustituyen. Una confirmación solicitada después de esa intención se rechaza con
CLOSE_REQUESTED. La confirmación que ya estaba pendiente se drena antes de decidir
si cerrar. Al salir se ejecuta el mismo cierre de 2B.1 directamente **solo si no hay
errores ni confirmaciones rechazadas y el resultado no es rejected o
dependency_failed**. En cualquier otro caso se descarta la intención para esa
operación: no hay MATCH_FINISHED, limpieza ni cambio de ciclo de vida, y no se
arrastra la intención a operaciones posteriores. Se conservan las versiones y
datos de las transiciones ya confirmadas; la partida permanece running y admite
un cierre explícito posterior con manager.finish(). El cierre exitoso no reenvía
la operación a su propia cola y aumenta la versión solo cuando su evento se acepta.
No se publican eventos después de MATCH_FINISHED.

Si el sink rechaza el cierre, el resultado incluye error y snapshot closing,
conservando las versiones de dominio confirmadas. Un `manager.finish` posterior
reintenta el mismo sobre, tal como en 2B.1. Este caso ocurre después de una operación
exitosa que sí podía cerrar. El resultado informa el error de cierre/limpieza;
confirmations y snapshot siguen mostrando lo realmente confirmado. Ningún error
deshace el estado anterior.

Sin celda optativa, create/activate/getSnapshot/finish/discard siguen funcionando
como en 2A/2B.1, con sus mismas pruebas. Solo runOperation se rechaza con
COORDINATED_STATE_REQUIRED. `emitEvent` independiente continúa deshabilitado,
incluidos los tipos reservados; events debe formar parte de confirmTransition.
confirmTransition no está disponible durante preparación, prepared, activación
pendiente, cierre, finalización ni fuera del alcance de operación. Un intento en
preparación invalida la sesión, aunque el plugin capture la excepción.

## Pruebas y pendientes

El fixture `test/fixtures/sdk-transitions/plugin.mjs` es código ficticio: sus
pruebas ensamblan paquetes temporales usando el manifiesto de prueba existente.
No es Gato, no usa Prolog y no se instala en plugins/. El mock confirma MOVE_PLACED,
marca IA pendiente, falla y permite RETRY_AI sin repetir el movimiento humano.

Las regresiones de auditoría cubren intención de cierre tras una confirmación
sin await rechazada, intención anterior a confirmación inválida, resultados
rejected/dependency_failed, y fallo externo tras una transición confirmada. Todos
conservan running sin cierre automático. La prueba previa CLOSE_THEN_CONFIRM se
actualiza deliberadamente: esperar finished en ese caso contradice el nuevo
contrato, porque CLOSE_REQUESTED es un fallo de confirmación. El cierre exitoso
CLOSE y la idempotencia explícita mantienen su comportamiento.

Dos incrementos derivados del mismo contador se prueban tanto con solicitudes
inmediatas como con la primera detenida en el sink. Solo la primera puede
confirmarse; se comprueban eventos aceptados, datos, versión y el error persistente
CONCURRENT_TRANSITION. También se comprueba conservación de un prefijo confirmado,
rechazo del sink, confirmación única sin await y varias confirmaciones esperadas.
No se cambia acceptBatch ni la semántica de sus pruebas.

El sink ficticio con lotes prepara todos los eventos en un buffer privado y solo
entonces los agrega a su colección aceptada. Una prueba fuerza un fallo en el
segundo evento y verifica que no se aceptó el primero. Otra prueba incorpora un
**contraejemplo deliberado**: un sink que viola acceptBatch mediante un bucle
secuencial sí deja un prefijo. El host lo reporta como rechazo y no puede retirar
ese prefijo externo. La prueba documenta el límite, no acredita una garantía falsa.

Antes de dispatch público faltan: validación del sobre de acción y controles de
acceso, requestId/deduplicación, expectedVersion, límites de operación y timeouts,
política de dependencias/cancelación, transporte con aceptación de lote real,
observabilidad de fallos ambiguos, bootstrap HTTP y la migración incremental. La
activación/cierre continúan usando accept individual. No se modifican GameStats,
EventOutbox ni las clases/UI/servidor existentes.
