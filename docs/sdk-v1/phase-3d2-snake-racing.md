# Fase 3D.2 — Snake y Circuito como paquetes SDK

Se añaden los dos plugins de servidor restantes. Los tres videojuegos pueden
prepararse y activarse con el registro, loader, fábrica, manager, HTTP y Outbox
existentes, sin modificar esos componentes ni Gato. No hay migración visual:
ambos HTML indican expresamente que la interfaz jugable está pendiente.

## Estructura y responsabilidades

```text
plugins/snake/                  plugins/racing/
  game.json                      game.json
  server/                        server/
    index.mjs                      index.mjs
    snake-session.mjs              racing-session.mjs
    snake-rules.mjs                racing-rules.mjs
  web/index.html                 web/index.html
  analytics/profile.json         analytics/profile.json
```

Los entrypoints exportan default GamePlugin con initializationContract y
createSession(context, options). Las sesiones implementan getSnapshot, dispatch
y finish, y crean exactamente una celda context.createState. Las reglas son
puras: calculan candidatos/eventos sin I/O, aleatoriedad ni reloj. Las sesiones
inyectan random/clock por constructor, coordinan la confirmación y solicitan el
cierre. No hay Match privado, motor común, colas adicionales ni estado global
mutable de partida. Los imports productivos son internos a cada paquete.

En ambas sesiones finish() no modifica el dominio: el administrador controla
la finalización. getSnapshot solo lee la celda. La identidad, lifecycle, versión
pública, serialización de operaciones y sobres de eventos siguen perteneciendo
al SDK. No se llama emitEvent ni se generan UUIDs o eventos de inicio/cierre.

## Manifiestos e inicialización

Ambos usan manifestVersion=1, sdkVersion=1.0, version=1.1.0, players min=max=1,
participante obligatorio `{id:'human',role:'human'}`, pause/resume/ai=false y
multipleInstances=false. El web entrypoint es HTML y el perfil apunta a
analytics/profile.json. La raíz del paquete se puede trasladar sin cambios.

Snake: id/name snake/Snake, category arcade, opción entera size con
values=[12,20,28], default=20. Declara startData.gridSize entero requerido,
equalsOption=size. Inicio: players=['human'] y gridSize.

Circuito: id/name racing/Circuito, category racing, options=[]. Declara startData
vacío. Inicio: players=['human'], igual al histórico. Las tres vueltas son reglas
del paquete; no se admite un parámetro HTTP para alterarlas.

multipleInstances=false restringe a una preparación/sesión no finalizada por
tipo y manager. Permite simultáneamente Gato, Snake y Circuito. La regla no se
codifica mediante IDs en el host. No es una restricción global entre el SDK y
las rutas históricas que aún coexisten, ni entre procesos. Si una evaluación
académica exige varias instancias del mismo tipo, deberá revisarse esa política
de producto expresamente; el SDK sigue soportando plugins que declaran true.

## Snake

Acción exacta: `TICK`, payload `{direction:'up'|'down'|'left'|'right'}`.
Todos los campos son obligatorios y no se admiten extras. Nombre/payload
inválidos o un resultado terminal se rechazan antes de calcular candidatos.

Estado JSON: size, body, direction, food, points y result. Inicialización como
el histórico: head.x=floor(size*0.3), head.y=floor(size/2), tres segmentos hacia
la izquierda, rumbo right, points=0, result=null y manzana en una celda libre.

Cada TICK avanza una casilla. La inversión directa se ignora, manteniendo rumbo.
Se calcula primero la nueva dirección/cabeza; una colisión conserva las
posiciones del cuerpo, como el histórico. La prueba de cuerpo excluye la cola
si se va a desplazar; al comer incluye todo el cuerpo. Se detectan pared y
autocolisión; result=game_over. Al comer aumenta points en 10 y crece un segmento.
La lista de casillas libres conserva el orden histórico (filas y columnas).
Sin casillas libres: food=null y result=board_completed.

| Situación | Confirmación | Después |
| --- | --- | --- |
| Movimiento normal | data nueva, events=[] | Continúa running |
| Manzana | data y APPLE_EATEN `{points:10}` | Nueva comida libre |
| Colisión | data terminal y PLAYER_DIED `{cause:'wall'|'self_collision'}` | Solicita finishMatch(completed) |
| Última manzana | data terminal y APPLE_EATEN | Cierre sin PLAYER_DIED |

Los eventos de dominio incluyen playerId human. APPLE_EATEN publica incremento,
nunca el acumulado. Cada confirmación usa objetos/arrays nuevos sin mutar los
datos congelados anteriores.

SnakeSession recibe `{rules=new SnakeRules(),random=Math.random}` por instancia.
No parchea Math.random ni acepta una fuente por HTTP. La fuente se consulta solo
al preparar/reubicar comida, antes de proponer el candidato. Si el sink rechaza,
body, food y points confirmados no cambian. La muestra aleatoria ya consultada
puede haberse consumido: no se promete revertir la fuente externa. Un requestId
fallido repetido devuelve su resultado guardado sin otra muestra; un ID nuevo
puede elegir otra comida al reintentar. Nunca se avanza por timer automático.

## Circuito

Acción exacta: `STEP`, payload `{lane:0|1|2,accelerate:boolean,brake:boolean}`.
Los tres campos son obligatorios, sin extras ni defaults implícitos de acciones.
La validación precede incluso a la consulta del reloj.

Estado JSON: lap, totalLaps=3, progress, lapLength=1200, speed, lane,
collisions, lapTimes, obstacles, hit, lastTick, lapStarted y result. hit es un
array de índices, no Set. No se almacenan Date, funciones ni objetos no JSON.
lastTick/lapStarted son lecturas enteras de milisegundos de la fuente temporal.

Se conservan carril inicial 1, speed=0, obstáculos (240,1), (510,0), (790,2),
(1040,1) y el orden físico histórico:

1. Leer now y calcular dt=max(0,min((now-lastTick)/1000,0.25)).
2. Actualizar carril y speed con +65*dt al acelerar o -18*dt pasivo, -140*dt
   adicional al frenar, limitado entre 0 y 180.
3. Avanzar progress con esa velocidad **antes** de penalizar colisiones.
4. Recorrer obstáculos en su orden; si cruza la posición en el mismo carril y
   aún no se impactó esta vuelta, registrar su índice, multiplicar speed por
   0.3 e incrementar collisions. Proponer OBSTACLE_HIT `{lap:lap+1,lane}`.
5. Si cruza 1200, incrementar lap una vez, conservar el resto de progress,
   añadir durationMs=max(1,now-lapStarted), reiniciar lapStarted y hit. Proponer
   LAP_COMPLETED `{lap,durationMs}`. Al llegar a 3: result=race_completed.
6. Confirmar estado y todos los eventos juntos; después solicitar cierre si
   terminó. Si coinciden impacto/meta, OBSTACLE_HIT precede a LAP_COMPLETED.

Ambos eventos usan playerId human. El límite físico de avance es 45 por paso;
con los obstáculos productivos el último está a 1040, de modo que no suele haber
impacto/meta juntos. La prueba del lote conjunto usa un escenario inicial
inyectado de pruebas, sin cambiar las posiciones de producción.

RacingSession recibe `{rules=new RacingRules(),clock=Date.now}` por instancia.
El reloj es una dependencia, no una segunda copia del estado temporal. Se guarda
now en el candidato junto a la física; solo se publican al confirmar. Un fallo
del sink conserva también lastTick y lapStarted. El siguiente intento con ID
nuevo usa el tiempo desde la última confirmación (con el mismo límite de dt),
y la vuelta sigue midiendo tiempo real transcurrido, incluidos intervalos largos.
No se generan timers durante preparación ni ejecución productiva.

## Diferencias justificadas

Se conserva la física interna de Racing sin redondeos. El snapshot histórico
mostraba Math.round(speed); el nuevo dominio conserva el valor preciso para
calcular el siguiente paso. La futura UI puede redondear para presentar.
Se exponen hit/lastTick/lapStarted como datos JSON del dominio para coordinar
física y tiempo; no duplican lifecycle ni versión del host.

El reloj debe devolver milisegundos enteros seguros, no negativos y no anteriores
al lastTick confirmado. Una lectura inválida/retroceso falla la operación sin
mutación (dependency_failed del SDK); no sustituye el reloj confirmado. El
histórico toleraba retrocesos con dt=0 y podía mover lastTick hacia atrás. Esta
guardia evita duraciones/avances incoherentes; no se cambia Date.now global.
Se mantiene el mínimo histórico de 1 ms para una duración de vuelta cero.

Los sobres usan gameVersion=1.1.0 (histórico 1.1). Snapshots contienen datos bajo
data y lifecycle SDK running/finished. Las versiones corresponden a una
confirmación por acción más la versión de cierre, no a touch() histórico.
El cierre administrativo conserva result y los demás datos; no fabrica
race_completed, game_over o un resultado 'abandoned'. El motivo vive en el cierre
del host. Las acciones SDK exigen payload completo, mientras las históricas
admitían algunos campos omitidos. Las rutas históricas mantienen su comportamiento.

## Eventos, perfiles y aceptación local

Se copian sin cambios semánticos los perfiles fijados en GameStats
4adee854ea3b35148b1eadd0549d4d8e647b345c, profileVersion=1.0.0.
La integridad se prueba con blobs Git conocidos, sin .deps, Git ejecutable ni
repositorios externos en las suites (CRLF de checkout se normaliza a LF):

- Snake: 04c242dacea70a1c84e91240f04dc69d56764cc9.
- Circuito: 2d9631f0807c6d2ab437165cf1e41f8485f55b62.

Snake conserva compatibilidad con apples.match, apples.player, points.player,
points_per_apple.player, deaths.player, lifetime.player, apples.burst y
duration.match. Circuito con laps.match, laps.player, lap_time.total.player,
lap_time.avg.player y duration.match. Copiar el archivo no lo instala en Scala;
el servicio fijado ya contiene estos perfiles. No hay calculadoras analíticas
en el runtime JS ni cambios a Go/Scala/lock.

El SDK aplica requestId, expectedVersion y la cola por partida. Un replay no
repite física, muestra aleatoria, reloj ni eventos y devuelve el snapshot
original. Se mantiene el historial FIFO de 128 solicitudes, sin garantía tras
expulsión/reinicio. La aceptación de varios eventos usa el acceptBatch existente;
un rechazo no publica prefijos ni cambia el candidato confirmado. No se promete
rollback de confirmaciones anteriores, persistencia o atomicidad ante caída del
proceso. Aceptación local y entrega a Go/cálculo Scala son etapas distintas.

## Pruebas aisladas

Orden de trabajo: Snake, Circuito y multijuego. Suites nuevas:

```powershell
node --test test/sdk-snake.test.mjs
node --test test/sdk-racing.test.mjs
node --test test/sdk-multigame.test.mjs
```

Snake agrupa los casos de contrato, tamaños, comida/crecimiento, dirección,
pared/cuerpo/cola, tablero completo, replay/versiones, rechazo del sink e
independencia de fuentes en 8 pruebas. Circuito agrupa contrato/controles,
velocidad/dt, impacto, lotes, vueltas y cierre, replay/versiones, rechazo con
reloj y aislamiento en 9 pruebas. Incluye comparación contra la clase Racing
histórica con reloj controlado en todos los pasos, sin ejecutar la suite
histórica que contiene Prolog real. No se ejecuta test/games.test.mjs.

Se carga el paquete real mediante Registry, Loader, Factory y Manager. Los
escenarios controlados copian el paquete y reemplazan **solo su fábrica temporal**
para inyectar dependencias y escenarios en las clases auténticas; no hay hooks de
prueba en producción. Los estados de cuerpo casi lleno o meta cercana solo
existen en esas pruebas. Las inicializaciones productivas sin sustitución y
sus manifiestos también se prueban. El helper es exclusivo de tests, no un
motor de simulación ni código importado por los plugins.

Multijuego tiene 2 pruebas: bootstrap real explícito de los tres paquetes con
un Manager y Outbox, creación simultánea, operaciones paralelas, una partida
progresando mientras la otra espera, cierre aislado, política por manifiesto,
identidades y HTTP genérico (catálogo/snapshots/acciones/replay/cierre). Gato solo
se prepara/activa, sin llamar Prolog. El fetcher Go está simulado y el servidor
HTTP de pruebas es loopback efímero. No se lanzan servicios ni procesos externos.

La regresión completa se limita a las suites SDK, HTTP y Outbox específicas;
no usar npm test ni filtros de exclusión sobre suites que invocan Prolog.
Comprobar sintaxis de cada archivo nuevo con node --check y git diff --check.
Los resultados finales de ejecución se informan junto a la entrega.

Verificación de esta implementación: las 8 pruebas Snake, 9 Circuito y 2
multijuego pasaron en el orden anterior. La regresión combinada con Gato y todas
las suites SDK/HTTP/Outbox específicas pasó **167/167**, sin fallos ni omisiones.
Las **19/19** pruebas nuevas pasaron además en una copia temporal sin .deps ni
.git, verificando que los perfiles y suites no requieren repositorios externos.
No se ejecutó la suite histórica con Prolog ni ningún humo real.

## Humo manual real (no ejecutado por Codex)

Con Go y Scala ya iniciados por el equipo:

```powershell
node scripts/sdk-snake-racing-smoke.mjs --go-url http://127.0.0.1:8080 --timeout-ms 15000
```

El script comprueba GET /health y /dashboard y levanta **solo** GameConsole
temporal en loopback/puerto efímero. Confía explícitamente en snake/racing del
directorio plugins; no carga Gato ni Prolog. Usa paquetes auténticos, Math.random
y Date.now productivos, sin sustituir código, reloj global ni estado interno.
Cada ejecución crea dos UUID nuevos y datos de prueba remotos.

Se mantienen ambas partidas abiertas. Snake usa la comida visible para planear
una ruta simple que evita las casillas inicialmente ocupadas (tablero inicial
de tres segmentos); si no hay una ruta verificable, falla en vez de omitir la
manzana. No se exige una posición aleatoria fija: se adapta al snapshot. Comprueba
una manzana/+10 en vivo y continúa recto hasta PLAYER_DIED/cierre dentro de un
límite de pasos. Los casos cuerpo/cola/tablero completo y bursts temporales
exactos se demuestran determinísticamente en unit tests o en GameStats; no se
inventa un burst de tres manzanas si el recorrido real no lo produce.

Circuito avanza con STEP cada 250 ms de tiempo real, acelerando y eligiendo
carriles para evitar obstáculos; verifica la primera vuelta mientras open y
las tres vueltas/cierre final. Tiene máximo 800 pasos y un presupuesto de
cuatro minutos para su bucle, más las consultas HTTP (timeout configurable
1000–60000 ms). Las consultas y eventIds de Go deben coincidir con el prefijo
entregado. Verifica perfil/fuentes/basis, conteos/puntos/promedios, duración y
estados provisional/final/unavailable de las métricas; burst se comprueba por
estructura/base y límites según evidencia, sin recalcular un motor Scala.
Repite acciones con el mismo requestId y exige resultado idéntico sin nuevos
eventos; repite finish sin duplicar cierres. La suma/promedios en el script son
aserciones de resultados esperados, no calculadoras para la aplicación.

PASSED y salida 0 requieren todas las aserciones reales. Un fallo/202 después
del flush, errores de servicio o métricas inconsistentes hacen fallar el humo.
El servidor y Outbox temporales se cierran en finally; un fallo puede dejar una
partida remota abierta y no se promete rollback. No se instalan servicios,
perfiles, Docker, dependencias ni procesos persistentes. Aquí solo se revisa
su sintaxis; no se declara demostrada esta nueva integración real.

Pendientes: web jugable, iframe, bridge, selección/controles de partidas y
despliegue/empaquetado. Se conservan las tres rutas/juegos históricos durante
la transición, sin un cuarto videojuego productivo ni fixtures instalados.
