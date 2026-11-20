# Fase 3D.1 — primer paquete real: Gato

> **Informe histórico de etapa.** Los alcances, comandos y verificaciones siguientes
> corresponden a esta fase; no son la guía de despliegue vigente. Consultar el
> [README principal](../../README.md) y el [estado de entrega](../entrega.md).

Implementado el plugin de servidor `tic-tac-toe` 1.1.0. Utiliza las rutas genéricas
SDK sin modificar host, reglas históricas ni frontend. No es todavía jugable
en el navegador: el HTML es un marcador explícito de integración pendiente.
El equipo reporta PASSED del humo HTTP de la fase anterior; el humo de este
plugin con Prolog y análisis reales requiere una nueva ejecución manual.

## Patrón normativo de paquete

```text
plugins/tic-tac-toe/
  game.json
  server/
    index.mjs
    gato-session.mjs
    gato-rules.mjs
    prolog-adapter.mjs
  prolog/
    gato.pl
    gato_tests.pl
  web/
    index.html
  analytics/
    profile.json
```

Un paquete instala su manifiesto junto al código y recursos privados. Los imports
del servidor son relativos al propio paquete o `node:`. No importa clases,
helpers ni SDK privado del host. Puede copiarse íntegro a otro subdirectorio de
plugins confiables sin modificar el host ni su código. No incorpora dependencias
npm, una clase Match ni otro framework de ejecución.

`game.json` usa exactamente SDK 1.0/manifestVersion 1, versión 1.1.0,
category strategy, capabilities pause/resume=false, multipleInstances=false,
ai=true; players min=max=2. La opción enum difficulty admite easy/medium/hard,
default hard como el servidor histórico. Una UI futura puede elegir medium
explícitamente. Declarar HTML no sirve archivos ni crea iframe/bridge.

Para futuras migraciones se conserva esta separación: entrada SDK, sesión de
dominio, reglas, adaptadores privados de dependencias, web y perfil opcional.
Los recursos de otros juegos solo se incorporarán en sus propias fases.

## Responsabilidades e interfaces

- `GatoRules`: reglas puras, casillas legales, turno, líneas y empate. Los
  candidatos usan arrays nuevos; no posee un tablero mutable.
- `GatoSession`: mantiene únicamente el handle de una celda creada con
  `context.createState`, reglas, adaptador y contexto público. Orquesta
  confirmaciones secuenciales, sin identidad/versiones/lifecycle propios.
- `PrologAdapter`: frontera de proceso, límites y validación de decisiones.
  No consulta GameStats ni emite eventos. La inyección opcional `request` es
  por instancia para sustituir esa frontera en pruebas, sin hooks globales
  en el paquete productivo ni configuración de código recibida por HTTP.

`server/index.mjs` exporta default GamePlugin:

```js
initializationContract = {
  participants: [
    {id:'human', role:'human', required:true},
    {id:'prolog', role:'ai', required:true}
  ],
  startData: {
    symbols: {type:'object', required:true},
    difficulty: {type:'string', required:true, equalsOption:'difficulty'}
  }
}
createSession(context, options) // {session: GatoSession, startData}
```

La sesión implementa `getSnapshot()`, `dispatch(action)` y `finish()`.
La preparación crea nueve casillas vacías, turn=0, difficulty validada,
winningLine=[], lastDecision=null, result=null y awaitingAI=false.
Devuelve symbols={human:'X',prolog:'O'} y difficulty. No ejecuta Prolog, crea
procesos ni emite MATCH_STARTED. El SDK comprueba roster/tipos/equalsOption;
la asignación concreta de symbols la fija el paquete (el descriptor v1 no tiene
un esquema de claves internas para objetos). Sus pruebas verifican esa asignación.

## Acciones y transiciones

El sobre conserva requestId/type/payload/expectedVersion del SDK. Los únicos
tipos propios son:

| Acción | Payload exacto | Condición |
| --- | --- | --- |
| PLACE_MARK | `{index: entero 0..8}` | Casilla vacía, turno humano par, sin awaitingAI ni resultado |
| RETRY_AI | `{}` | awaitingAI=true, turno impar y sin resultado |

Nombre, payload, casilla o turno inválidos devuelven `{outcome:'rejected'}`;
el manager compone committed=false, confirmations=0 y snapshot intacto.
Un rechazo por lifecycle o versión lo resuelve el host antes del juego.

PLACE_MARK calcula un candidato con X, turn+1, línea/resultado y awaitingAI.
Confirma ese candidato y un MOVE_PLACED humano antes de llamar a Prolog.
Si hay victoria/empate, solicita finishMatch({reason:'completed'}) y no llama IA.
De lo contrario, solicita una decisión para el tablero **ya confirmado**.
La decisión válida genera otro candidato con O, turn+1, lastDecision,
awaitingAI=false y resultado actualizado. AI_DECISION y MOVE_PLACED de Prolog
se proponen en ese orden en **una sola confirmación**, usando acceptBatch del host.
Si termina, solicita finishMatch; el host genera MATCH_FINISHED una sola vez.

Cada marca confirma una versión pública. Una acción normal completa dos
confirmaciones/versiones; RETRY_AI exitoso confirma una. El cierre del host
añade su propia versión. Dos eventos IA no representan dos confirmaciones.
Los resultados de dominio son human_won, prolog_won o draw; result=null indica
ausencia de resultado. No se duplica running/closing/finished dentro del dominio.

## Prolog autocontenido

`prolog/gato.pl` y `gato_tests.pl` son copias exactas de los históricos. Conservan
easy=reglas_basicas, medium=reglas_tacticas y hard=minimax, preferencias y pruebas
existentes. El adaptador resuelve `../prolog/gato.pl` desde **su propio** import.meta.url.
No depende del cwd ni del programa Prolog global del host.

Invoca `SWIPL_PATH` o `swipl` con spawn, shell=false, windowsHide y argumentos
fijos `-q -s <programa del paquete> -g main -t halt`. Envía JSON con board
(vacíos traducidos a e), player=O y difficulty. El timeout de proceso es 8000 ms
(configurable al construir el adaptador); stdout se limita a 65536 bytes y UTF-8
válido. Stderr se drena sin guardarlo. Error de proceso, salida no JSON/excesiva,
cancelación o fallo de protocolo rechazan con PrologFailure de mensaje fijo.
No se publican rutas, stderr ni excepciones originales del proceso.

La respuesta debe contener exactamente index, score y algorithm: index entero
legal libre; algorithm coincidente con dificultad; score null para easy/medium
y -10, 0 o 10 para minimax, como el programa copiado. No se admite un movimiento
fuera del tablero, en casilla ocupada, un algoritmo inventado ni datos extra.
No se certifica la optimalidad de una respuesta por su schema: la estrategia
auténtica corresponde al programa Prolog y sus pruebas manuales.

## Eventos y análisis

Se conserva data de MOVE_PLACED: turn secuencial desde 1, row/column base cero,
symbol X/O y playerId human/prolog. AI_DECISION conserva algorithm, difficulty,
index, score y board **previo** a colocar O. lastDecision conserva la respuesta
validada, sin otra copia autoritativa del tablero.

El host asigna schemaVersion=1, UUIDs de evento/partida, timestamp, gameId y
gameVersion=1.1.0. Genera inicio con players=['human','prolog'], symbols y difficulty,
y cierre con reason. El plugin no llama randomUUID ni fabrica sobres.

`analytics/profile.json` es copia exacta de
`.deps/gamestats/docs/examples/profiles/tic-tac-toe.json` en la dependencia fijada
`4adee854ea3b35148b1eadd0549d4d8e647b345c`. Conserva profileVersion=1.0.0,
conteos moves.player/moves.match, duration.match y especialización
tic-tac-toe-line/v1 con board.result/board.winning_line. No se instala el perfil
en Scala ni se modifica GameStats/lock. Go organiza/valida el sobre; Scala deriva
métricas. Aceptación local no implica entrega remota ni cálculo analítico.

## Fallos parciales e idempotencia

Si falla Prolog tras X, la sesión comunica dependency_failed; el manager conserva
committed=true, confirmations=1, versión incrementada, X y awaitingAI=true.
No hay AI_DECISION/O/cierre. HTTP conserva 200 con el resultado completo.
Un PLACE_MARK nuevo durante esa espera se rechaza sin mutar. RETRY_AI con ID nuevo
puede completar O. Si vuelve a fallar antes de confirmar, committed=false para
**ese intento**, sin deshacer X ni su versión.

Repetir el mismo requestId/contenido recupera el resultado/snapshot original,
incluso después de recuperar IA. No representa otra consulta a Prolog. Se mantiene
la ventana FIFO de 128 resultados por instancia; no se promete idempotencia tras
expulsión/reinicio, persistencia ni atomicidad frente a caídas del proceso.

Solo se captura PrologFailure alrededor de la consulta IA. Un fallo de confirmación
queda bajo las garantías/códigos del coordinador (por ejemplo EVENT_ACCEPTANCE_FAILED),
sin confundirlo con una acción ilegal o deshacer confirmaciones anteriores.
Si falla la aceptación del lote IA, no se confirma O ni un prefijo AI_DECISION;
el tablero continúa pendiente y puede volver a intentarse.

## Diferencias y política de producto

Reglas, líneas, turnos X/O, dificultades, default hard y datos de eventos se
conservan. El protocolo de acciones ahora es PLACE_MARK/RETRY_AI y el snapshot
de dominio está bajo `snapshot.data`; el lifecycle usa running/finished del SDK,
no open/closed históricos. Las versiones corresponden a confirmaciones SDK,
no al contador touch de Match histórico. gameVersion pasa de 1.1 a 1.1.0.
Las respuestas IA se validan con más rigor que en la clase histórica.

Un cierre administrativo no modifica datos sin confirmación: finish() no muta
result, tablero ni awaitingAI. Un abandono puede dejar result=null (o IA pendiente)
con lifecycle finished y motivo en MATCH_FINISHED. El histórico rellenaba result
con el motivo de cierre. No se oculta esta diferencia con otro estado de lifecycle.

multipleInstances=false permite **una sesión SDK no finalizada** de Gato por
manager. Preparados/closing también ocupan esa plaza; una terminada libera la
posibilidad de crear otra, aunque siga contando en la cuota general de 500.
La regla procede solo del manifiesto, sin condicionales por ID en el host.
Otros plugins pueden declarar true, como demuestran las suites anteriores.
La coexistencia con el Map histórico no constituye un límite global entre ambas
APIs. La política puede entrar en tensión con una evaluación académica que exija
varios Gatos simultáneos: el equipo deberá decidirla antes del despliegue;
no se altera aquí el valor solicitado ni el SDK para ocultarla.

El catálogo histórico de tres juegos no se sustituye, el SDK sigue optativo y
este paquete representa Gato, no un cuarto videojuego distinto. Snake/Circuito,
web/iframe/bridge, Docker/empaquetado y despliegue analítico quedan pendientes.

## Pruebas aisladas y humo manual

```powershell
node --check plugins/tic-tac-toe/server/index.mjs
node --check plugins/tic-tac-toe/server/gato-session.mjs
node --check plugins/tic-tac-toe/server/gato-rules.mjs
node --check plugins/tic-tac-toe/server/prolog-adapter.mjs
node --check test/sdk-gato.test.mjs
node --check scripts/sdk-gato-smoke.mjs
node --test test/sdk-gato.test.mjs
git diff --check
```

Las pruebas copian el paquete real a un directorio temporal. Solo allí sustituyen
el adaptador por un doble por instancia que reutiliza el validador real; entrada,
sesión, reglas y recursos permanecen auténticos. Cubren bootstrap/HTTP loopback
efímero, contratos, eventos/versiones, fallos/recuperación, resultados y cuota.
La inicialización sin doble también se prueba, sin despachar IA ni crear procesos.
No hay hooks globales en producción, red externa ni SWI real en esas pruebas.

Para regresión se ejecutan las suites SDK/HTTP/Outbox existentes, sin modificarlas.
`test/games.test.mjs` contiene dos pruebas con SWI real: no debe ejecutarse
como parte de una verificación sin dependencias externas. El registro de esta
etapa incluye nueve pruebas históricas aprobadas, dos de ellas con SWI real;
esa ejecución se distingue de las pruebas aisladas del plugin.
Las pruebas nuevas del plugin no ejecutan SWI ni el humo real.

**Prueba manual complementaria**:

```powershell
$env:SWIPL_PATH = 'C:\ruta\swipl.exe' # opcional si ya está en PATH
node scripts/sdk-gato-smoke.mjs --go-url http://127.0.0.1:8080 --difficulty hard
```

El equipo debe tener Go/Scala levantados. El script comprueba SWI con --version,
Go /health y dashboard Go→Scala; no instala ni inicia esos servicios. Levanta
solo una consola temporal loopback/puerto efímero con el paquete auténtico y su
adaptador real. Crea la partida por HTTP, juega hasta un resultado terminal con
al menos una decisión Prolog real, comprueba replays, cierre único e IDs/conteos
en GET Go /matches. Consulta por HTTP SDK los conteos reales de movimientos,
board.result y duración en vivo/final, con sus fuentes, estados y basis.
No usa clases históricas ni instala perfiles. Vacía el Outbox antes de verificar
cada prefijo. Cierra servidor/Outbox en finally; una falla puede dejar una partida
remota abierta y el UUID se informa, sin prometer rollback.
Solo salida 0 y PASSED acreditan esa nueva comprobación real. Esta fase entrega
el script revisado sintácticamente, sin declarar probado Prolog/Go/Scala reales.
