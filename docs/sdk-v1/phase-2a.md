# Fase 2A — carga y preparación local, sin integración HTTP o GameStats

Este documento conserva el alcance auditado de 2A. Las extensiones vigentes de
activación/cierre, EventSink y contexto se describen en [Fase 2B.1](phase-2b1.md).
Las interfaces de preparación se conservan; las diferencias están indicadas allí.

Se implementan carga confiable, opciones, preparación declarativa y administración
de sesiones preparadas. No se activa el runtime de acciones ni se emiten eventos.
El servidor histórico no importa estos módulos. La UI y los tres juegos siguen
utilizando su implementación existente. El nuevo fixture está exclusivamente en
`test/fixtures/sdk-runtime/counter/`; no se instala en `plugins/`.

## Composición e interfaces implementadas

Código del anfitrión, sin solicitudes HTTP ni rutas proporcionadas por clientes:

```js
import { GamePluginLoader } from '../../server/sdk/loader.mjs';
import { GameSessionFactory } from '../../server/sdk/session-factory.mjs';
import { GameInstanceManager } from '../../server/sdk/instance-manager.mjs';

// registry procede de discoverPlugins; inspeccionar antes errores y catálogo obligatorio.
const loader = new GamePluginLoader(registry, { trustedIds: idsAprobadosPorElEquipo });
const factory = new GameSessionFactory(loader);
const manager = new GameInstanceManager(factory); // máximo 500, no Singleton
const snapshot = await manager.create(idRegistrado, { options: {}, players });
```

| Interfaz | Resultado / responsabilidad |
| --- | --- |
| `new GamePluginLoader(registry, {trustedIds = []})` | Reutiliza una instancia de `GameRegistry`; copia la lista de confianza. Sin autorización explícita no importa nada. |
| `await loader.load(gameId)` | Devuelve un objeto congelado `{manifest, initializationContract, createSession}`. Valida export default y descriptor; conserva una promesa de carga por ID, incluidos fallos. |
| `validateOptions(manifest, input = {})` | Objeto nuevo, profundamente congelado, con defaults y valores validados sin coerción. Rechaza claves desconocidas y valores no JSON. |
| `new GameSessionFactory(loader)` | Fábrica con seguimiento débil de identidades de sesión que ya produjo; sin estado de juego compartido. |
| `await factory.prepare(gameId, {options = {}, players?} = {})` | Handle interno `{matchId, manifest, options, players, startData, readData, dispose, session}`. UUID asignado por el host, entrada copiada antes de esperar. No publica en el manager. |
| `await handle.readData()` | Copia JSON validada de los datos actuales del plugin. |
| `await handle.dispose(reason)` | Aborta la señal e invoca `session.finish({reason})` como máximo una vez. |
| `handle.session` | Fachada congelada de métodos vinculados `dispatch` y opcionalmente `pause/resume`, reservada al host futuro y pruebas internas. No es API pública ni un coordinador de transiciones. |
| `new GameInstanceManager(factory, {limit = 500})` | Map privado por matchId; acepta un límite menor entre 1 y 500 para cuotas/pruebas. |
| `await manager.create(gameId, configuration = {})` | Prepara, comprueba y registra solo al finalizar correctamente; devuelve snapshot defensivo. |
| `await manager.getSnapshot(matchId)` | Snapshot defensivo serializado con las operaciones de esa instancia. |
| `await manager.list()` | Arreglo de snapshots, orden de creación. Consistencia por instancia, no transacción global. |
| `await manager.finish(matchId, {reason = 'cancelled'} = {})` | Cierre local idempotente y snapshot terminal. No emite MATCH_FINISHED. |
| `manager.size` | Número de sesiones registradas, incluidas las finalizadas. |

El handle de fábrica contiene funciones y es **solo interno**; no es un snapshot
serializable ni debe entregarse a web/clientes. El manager nunca expone handles,
sesiones, contextos, loaders o rutas. Su snapshot tiene exactamente:

```js
{
  matchId, gameId, gameVersion,
  state: 'prepared', // o 'finished'; nunca se activa running en 2A
  version: 0,        // pasa a 1 al cerrar; repetir cierre no incrementa
  players, options, startData, data
}
```

`prepared` es un estado local de infraestructura, anterior a la activación del
contrato diseñado. No significa que MATCH_STARTED haya sido emitido ni aceptado
por GameStats. El manager no ofrece `dispatch`, `pause` o `resume`: exponer acciones
requiere el coordinador de transiciones de una fase posterior. Las pruebas usan
el handle interno para comprobar aislamiento sin abrir esa API al producto.

## Frontera de confianza y carga

El loader recibe exclusivamente IDs del registro existente. Un ID desconocido,
una ruta o una URL como ID se rechazan. Estar registrado no concede confianza:
el equipo debe revisar/instalar el paquete y aprobar su ID en configuración del
host. No se debe construir `trustedIds` desde una solicitud o automáticamente
desde todo el catálogo. Es una política de autorización del equipo, no una firma
criptográfica ni aislamiento de Node. Los imports transitivos tienen los mismos
permisos del proceso y también deben revisarse.

Antes del primer import se vuelve a validar el paquete y se comparan manifiesto,
raíz y rutas reales con lo registrado. Solo entonces se utiliza `import()` con
`pathToFileURL(paths.server)`. No se importa HTML. El caché es de ejecutables, no
un segundo registro ni almacenamiento de partidas. No hay hot reload o reintento
de módulos fallidos en ese loader. ESM conserva además su caché por URL de proceso.

La autorización supone archivos instalados estables durante toda la ejecución.
No hay hashes de contenido, bloqueo del sistema de archivos ni defensa TOCTOU:
cambiar solo el contenido de un módulo no se detecta comparando metadatos. Para
actualizaciones se requiere una nueva revisión y reinicio del proceso. La política
de catálogo obligatorio del README sigue pendiente de conectar al arranque real.

## Contrato declarativo exacto de preparación

El módulo servidor exporta un objeto `default` con `createSession` invocable y
`initializationContract` como JSON. La declaración se copia, valida y congela:

```js
initializationContract: {
  participants: [
    { id: 'human', role: 'human', required: true },
    { id: 'helper', role: 'ai', required: false }
  ],
  startData: {
    size: { type: 'integer', required: true, equalsOption: 'size' },
    actor: { type: 'playerId', required: true }
  }
}
```

Solo se permiten esas dos claves superiores. `participants` contiene entre
`manifest.players.min` y 16 declaraciones con exactamente `id`, `role`, `required`.
IDs únicos; ID y rol son slugs de 1–64 caracteres. El número de requeridos no
excede `manifest.players.max`. El host recibe `players` como arreglo de objetos
`{id,role}`; si se omite, usa los declarados requeridos. Rechaza repetidos, IDs o
roles no declarados, ausencia de requeridos y cantidades fuera del manifiesto.
Si los requeridos no alcanzan el mínimo, el llamador debe incluir opcionales.

`startData` declara hasta 32 campos camelCase/ASCII (`[a-zA-Z][a-zA-Z0-9]{0,63}`).
Cada regla tiene `type`, `required` booleano y opcionalmente `equalsOption`.
Se rechazan nombres reservados de identidad/evento: `players`, `gameId`,
`gameVersion`, `matchId`, `schemaVersion`, `eventId`, `timestamp`.

Tipos disponibles: `string`, `integer` (entero seguro), `number` (finito),
`boolean`, `object` (objeto JSON), `array`, `playerId` (ID de un participante de
esta sesión). No se admite null como valor de esos tipos. `equalsOption` exige
igualdad estricta con una opción declarada y de tipo compatible: entero/número
con opción integer, boolean con boolean, string/playerId con string o enum.
No se admite en object/array. No hay coerción, schemas recursivos, funciones de
validación o lógica por gameId. object/array validan JSON, no su semántica interna.

`createSession(context, options)` devuelve exactamente `{session, startData}`,
sincrónicamente o mediante Promise. La sesión debe ser un objeto nuevo con
`getSnapshot`, `dispatch`, `finish` invocables. `pause` y `resume` deben existir
ambos cuando sus capacidades son verdaderas y estar ausentes en caso contrario.
El resultado `startData` debe ser un objeto JSON, sin campos no declarados, con
los requeridos presentes y reglas satisfechas. `getSnapshot()` devuelve solo un
objeto JSON de datos del juego; se comprueba antes de registrar la instancia.

El contexto congelado incluye `gameId`, `gameVersion`, UUID `matchId`, participantes
profundamente congelados, logger sin efectos (`debug/info/warn/error`), `signal`
y `services` vacío y congelado. Cada sesión tiene su propio AbortController,
que no se expone; el AbortSignal nativo no se clona ni congela recursivamente.
No se inyectan red, Prolog o credenciales. Las opciones se validan reutilizando
las reglas del manifiesto para sus defaults, y se copian/congelan antes de darlas
al plugin; nunca se usan como objeto mutable del cliente.

`emitEvent` y `finishMatch` existen como puntos de extensión que arrojan errores:
`EVENT_DURING_PREPARATION` durante la preparación y `EVENTS_UNAVAILABLE` después.
Un intento durante preparación invalida la sesión aunque el plugin capture el
error. Si el intento escapa de createSession, el error externo es
`PREPARATION_FAILED`. Estos puntos no aceptan ni transportan eventos en 2A.
No hay timers del juego ni acciones durante preparación; son obligaciones del
plugin confiable, no restricciones de un sandbox.

Ante interfaz/datos inválidos se aborta la señal y se intenta limpiar la sesión
devuelta mediante `finish({reason:'initialization_failed'})`, conservando el error
original. Si la fábrica lanza antes de devolver un objeto, le corresponde limpiar
los recursos que aún no entregó al host. Se rechaza reutilizar un objeto que esta
fábrica ya recibió, sin limpiar el objeto que pertenece a otra preparación. No es
posible detectar toda forma de estado global oculto: la independencia también es
una obligación del plugin y de su revisión.

## Administración, cierre y errores

GameConsole controla Map, ciclo de vida y versión; el plugin controla sus datos.
La cuota cuenta registros finalizados y reservas en curso, para que dos create
concurrentes no superen el límite. Fallos de creación liberan la reserva.
Con `multipleInstances: false` solo se publica una sesión sin finalizar; una
preparación concurrente que pierde se limpia y no se publica.

Cada registro tiene su propia cola de Promises para snapshots y cierre. Un fallo
no envenena la cola; otras partidas no esperan esa cola. El cierre es terminal,
aborta la señal y ejecuta limpieza una sola vez. El reporte final conserva los
últimos datos válidos **previos a la limpieza**, porque esta puede descartar los
recursos del juego. Se conserva una copia diagnóstica del último snapshot válido;
no es otro motor de reglas. Si la lectura o limpieza final falla, finish rechaza
con error saneado, pero el registro queda finished/version 1 y se puede consultar
su reporte terminal. Un cierre repetido devuelve ese reporte sin reintentar
efectos; la futura política de recuperación de recursos queda fuera de 2A.

Los snapshots son copias defensivas serializables; se rechazan undefined,
funciones, bigint, números no finitos, ciclos, fechas/tipos especiales, getters,
símbolos, arreglos dispersos y profundidad mayor a 64, en lugar de dejar que
JSON.stringify los omita o transforme silenciosamente.

Los errores son `SDKError` con `code` y mensaje fijo, sin mensajes crudos del
plugin ni rutas locales. Códigos: `INVALID_CONFIGURATION`, `UNKNOWN_PLUGIN`,
`UNTRUSTED_PLUGIN`, `PLUGIN_CHANGED`, `PLUGIN_LOAD_FAILED`,
`INVALID_PLUGIN_INTERFACE`, `INVALID_OPTIONS`, `INVALID_PLAYERS`,
`PREPARATION_FAILED`, `INVALID_SESSION_INTERFACE`, `REUSED_SESSION`,
`INVALID_START_DATA`, `INVALID_SNAPSHOT`, `EVENT_DURING_PREPARATION`,
`EVENTS_UNAVAILABLE`, `CLEANUP_FAILED`, `INSTANCE_LIMIT`,
`MULTIPLE_INSTANCES_DISABLED`, `DUPLICATE_MATCH`, `UNKNOWN_MATCH`, `INVALID_JSON_VALUE`.
No se definen respuestas HTTP en esta fase.

## Patrones, verificación y pendientes

Registry existente + Loader separan catálogo y ejecución; Factory construye cada
sesión; Dependency Injection proporciona contexto mínimo; el manager es la fachada
de preparación/lectura/cierre. No se usa Singleton. No se implementan Observer,
Adapter de eventos o un coordinador State completo de partidas activas.

Las pruebas específicas son `test/sdk-v1.test.mjs` y `test/sdk-runtime.test.mjs`.
Usan fixtures/mocks, importaciones locales confiables, memoria y archivos temporales.
No usan servicios, sockets, procesos de juego, Prolog ni GameStats. El caso histórico
de symlinks/junctions puede omitirse explícitamente si el entorno los prohíbe.

Pendientes: activación con MATCH_STARTED, GameEventAdapter y Outbox, acciones
públicas/deduplicación/expectedVersion, coordinación de confirmaciones y fallos de
dependencias externas, finishMatch real, pause/resume públicos, cuotas de payload
y timeouts, servicios autorizados, bootstrap obligatorio, transporte web/iframe y
migraciones. La semántica futura de fallos parciales del contrato diseñado se
conserva; 2A no intenta implementarla mediante rollback ni acciones sin coordinador.
