# GameConsole

Proyecto 2 de Lenguajes de Programación. Francisco Castillo y Justin.
Consola web con exactamente tres videojuegos: Gato contra Prolog, Snake y
Circuito de tres vueltas. Partidas independientes y panel consultado a GameStats.

Este README es el punto de entrada para Justin y cualquier persona que continúe
el proyecto. La versión 1.1 añade preparación antes de jugar, tres dificultades
en Gato y tres tamaños de Snake. Biblioteca y Estadísticas siguen separadas.

| Juego | Modalidad actual | Opciones |
| --- | --- | --- |
| Gato | Persona contra computadora en Prolog | Baja, media o alta. |
| Snake | Una persona | Cuadrícula de 12×12, 20×20 o 28×28. |
| Circuito | Una persona | Carrera individual de tres vueltas. |

El video final, la revisión académica y la entrega en Tec Digital siguen
pendientes. La modalidad persona contra persona queda pendiente de confirmar
con el docente: no se ha añadido ni se asume como requisito del enunciado revisado.

## Ejecutar con Docker

Requisitos: Git, Node.js 22 o posterior para el preparador y Docker Desktop con
contenedores Linux. No es necesario instalar Go, Scala ni Prolog en la laptop.

```sh
git clone https://github.com/franncd26/gameconsole.git
cd gameconsole
node scripts/deploy.mjs
```

Abrir http://127.0.0.1:3000. El preparador descarga la versión de GameStats
fijada en `gamestats.lock.json`, construye y arranca los tres servicios.
En Windows, si la ruta contiene tildes, prepara una copia de construcción
en una ruta temporal sin tildes para evitar el problema de Docker del proyecto 1.
La primera construcción necesita Internet y puede tardar varios minutos.

```sh
node scripts/deploy.mjs --stop
```

El despliegue elegido es **local con Docker Compose**, equivalente a GameStats.
El repositorio y CI no representan alojamiento remoto. Los puertos se publican
solo en la propia laptop; Scala permanece dentro de la red Docker.
Para otros puertos configurar `PORT` y `GAMESTATS_PORT` antes de ejecutar.
Con la dependencia preparada y una ruta sin tildes también puede utilizarse
`docker compose up -d --build --wait` directamente.

## Jugar

- **Gato:** elige dificultad antes de empezar; la interfaz propone media. Eres
  X y Prolog juega O. Completa una fila, columna o diagonal para ganar. Una
  línea de O es derrota; tablero lleno sin ganador es empate.
- **Snake:** elige 12×12, 20×20 o 28×28; cambia el número de casillas, no la
  velocidad ni el espacio visual. Pulsa Continuar y usa flechas o WASD. Cada manzana agrega 10 puntos.
  Chocar con la pared o el cuerpo termina la partida. Espacio pausa/reanuda.
- **Circuito:** pulsa Continuar. Mantén arriba/W o el control táctil para acelerar;
  abajo/S frena y los lados cambian carril. Completa tres vueltas; los obstáculos
  reducen la velocidad, pero no eliminan al jugador. No hay límite de tiempo ni
  derrota automática: ganas al completar tres vueltas o abandonas con Finalizar.
  Los tiempos incluyen las pausas de la partida.

Todos muestran una ventana con objetivo, controles y condiciones de finalización.
Cancelar esa ventana no registra una instancia. Durante la partida, «Cómo jugar»
permite consultar las instrucciones y regresar sin crear otra partida.

| Dificultad de Gato | Reglas ejecutadas en Prolog |
| --- | --- |
| Baja | Aprovechar una victoria inmediata; si no existe, tomar la primera casilla libre. Puede dejar amenazas sin bloquear. |
| Media | Ganar, bloquear una derrota inmediata y preferir el centro o una casilla libre. No explora todas las continuaciones. |
| Alta | Minimax completo, con desempate determinista. No pierde con juego legal; el mejor resultado del usuario es empate. |

Ningún nivel selecciona movimientos al azar. En baja y media, las limitaciones
son intencionales para ofrecer oportunidades al jugador. Solo alta conserva
la garantía de no derrota. Si Prolog falla, puede reintentarse su turno sin
perder la jugada humana que ya fue realizada.

Puedes abrir varias pestañas e iniciar partidas independientes. El botón
«Abrir en otra pestaña» crea una nueva instancia del mismo juego. La biblioteca
permite retomar partidas. Al cambiar de vista o pestaña se suspende el avance
del juego de reflejos/velocidad; las otras pestañas visibles pueden seguir jugando.
«Finalizar» cierra una partida abandonada. Cerrar la pestaña conserva la partida
para retomarla desde la biblioteca mientras siga vivo el servidor.

El panel consulta GameStats cada 2,5 segundos. Los datos cubren la sesión del
servicio Go: reiniciarlo elimina su historial. No hay persistencia de partidas.
Las instancias incluyen partidas activas y finalizadas, también abandonadas.

## Desarrollo y pruebas

Node.js 22+ y SWI-Prolog en PATH. No hay dependencias npm externas.

```sh
npm test
swipl -q -s prolog/gato_tests.pl -g run_tests -t halt
npm run check
npm start
```

Para el servidor local, GameStats debe estar accesible en `http://127.0.0.1:8080`;
puede configurarse `GAMESTATS_URL`. `SWIPL_PATH` permite indicar el ejecutable.

Con el sistema integrado iniciado:

```sh
npm run test:integration
```

La prueba crea seis partidas reales simultáneas, completa los tres juegos,
consulta Go/Scala y verifica aislamiento, entregas, métricas válidas y conteos.
Escribe `evidence/integration.json`. No borra partidas existentes y crea seis
instancias adicionales cada vez. Durante su ejecución no inicies otras partidas
si quieres verificar el incremento exacto de seis en los contadores generales.

## Documentación

- [Arquitectura y decisiones](docs/arquitectura.md).
- [Contrato de integración](docs/integracion.md).
- [Verificación de requisitos](docs/entrega.md).
- [Guion de demostración](docs/video.md).

La CI ejecuta pruebas de juegos, HTTP, Prolog y una integración Docker completa.
GameStats conserva sus suites Go/Scala y añade pruebas para el resumen agregado.

## Repositorios y estado de la dependencia

- GameConsole: <https://github.com/franncd26/gameconsole> (privado).
- GameStats: <https://github.com/JusMH/gamestats>.
- Ampliación necesaria para el panel: <https://github.com/JusMH/gamestats/pull/17>.

Al preparar este relevo, la ampliación de GameStats está en la rama
`feature/gameconsole-dashboard`, separada de su main. `gamestats.lock.json`
fija el commit `4adee854ea3b35148b1eadd0549d4d8e647b345c`. No basta con usar
una versión anterior de main: le faltaría GET /dashboard.

La dependencia se descarga en `.deps/gamestats`, ignorada por Git. Esa carpeta
no sustituye el repositorio original de GameStats como lugar de desarrollo.
Si se modifica GameStats, hay que validar sus cambios y fijar un nuevo SHA en
GameConsole. Para entregar, conservar un commit exacto en lugar de una rama móvil.

Justin necesita acceso al repositorio privado concedido por su propietario.
No se incluyen tokens o contraseñas dentro del código ni de los archivos de entrega.

## Arquitectura y justificación de las decisiones

```text
Navegador: HTML, CSS y JavaScript
              │ HTTP del mismo origen
              ▼
GameConsole Node.js ── JSON por stdin/stdout ── SWI-Prolog
              │ eventos ordenados por partida
              ▼
GameStats Go ── snapshots HTTP ── GameStats Scala
              ▲                        │
              └──── métricas y resumen
```

Se eligieron módulos JavaScript nativos para mantener sencillo un proyecto de
tres juegos pequeños. No hay framework ni dependencias npm de ejecución.
El navegador dibuja Gato con botones HTML y Snake/Circuito con Canvas.
Node mantiene el estado, valida acciones, coordina Prolog y sirve la interfaz.

La programación orientada a objetos se concentra en `Match`, que abstrae
identidad, historial y ciclo de vida, y sus especializaciones `TicTacToe`, `Snake`
y `Racing`. El historial, el emisor y la secuencia de exclusión son privados.
Cada juego implementa sus reglas mediante acciones y snapshots; `EventOutbox`
separa el transporte del dominio y `GameConsole` coordina vistas y controles.

Prolog expresa líneas ganadoras, movimientos legales y estrategias como reglas.
Alta usa minimax y tabling para reutilizar subproblemas dentro de una consulta;
baja y media aplican estrategias deliberadamente limitadas. Node inicia el
intérprete con argumentos fijos, envía JSON por stdin, lee stdout y valida la
casilla resultante. Hay timeout; no se genera código de shell desde entradas.

Go mantiene recepción, agrupación y ciclo de vida; Scala mantiene los cálculos
funcionales. La consola presenta los resultados de GameStats, sin duplicar sus
estadísticas. Los juegos sí conservan las reglas y puntuaciones que necesitan
para funcionar; GameStats no se utiliza como reloj ni como motor del juego.

## Organización del código

| Archivo o carpeta | Responsabilidad |
| --- | --- |
| public/index.html | Biblioteca, estadísticas, partidas y diálogo de preparación/ayuda. |
| public/style.css | Diseño adaptativo, tableros, panel y diálogo. |
| public/app.mjs | Opciones, controles, dibujo y consultas periódicas. |
| server/index.mjs | API, validación y coordinación de partidas. |
| server/games.mjs | Clases y reglas de los tres juegos. |
| server/prolog.mjs | Ejecución del intérprete y lectura de su respuesta. |
| prolog/gato.pl | Las tres estrategias de dificultad. |
| server/outbox.mjs | Colas independientes, entrega y reintentos. |
| scripts/prepare.mjs | Descarga de la dependencia fijada. |
| scripts/deploy.mjs | Construcción y arranque Docker, incluidas rutas con tildes. |
| test/ y prolog/gato_tests.pl | Pruebas de reglas, HTTP, transporte y estrategias. |
| .github/workflows/ci.yml | Verificación automatizada del entorno integrado. |

## Cómo quedó Docker

| Servicio | Contenido | Acceso |
| --- | --- | --- |
| gameconsole | Node, interfaz, reglas e intérprete SWI-Prolog | Puerto local 3000. |
| go-ingestion | GameStats Go | Puerto local 8080. |
| scala-analysis | GameStats Scala con Java 21 | Puerto 9000 solo dentro de Docker. |

Prolog se ejecuta como proceso dentro de GameConsole; no existe un cuarto
servidor Prolog. Compose espera primero a Scala, luego a Go y finalmente a la
consola. Los contenedores de ejecución utilizan usuarios sin privilegios,
sistema de archivos de solo lectura y directorio temporal escribible.
Dockerfile empaqueta GameConsole; los Dockerfiles Go/Scala se obtienen del
commit fijado. Cambiar archivos del repositorio no modifica una imagen ya
construida: hay que reconstruir y recrear el servicio para ver los cambios.

## Contrato de creación y eventos

`POST /api/matches` acepta, por ejemplo:

```json
{"gameId":"tic-tac-toe","options":{"difficulty":"easy"}}
```

```json
{"gameId":"snake","options":{"size":28}}
```

```json
{"gameId":"racing"}
```

Para clientes anteriores, omitir opciones conserva Gato en alta y Snake en
20×20. La interfaz envía la selección explícitamente. Las opciones se validan
antes de crear la instancia; valores incorrectos responden 400 sin registrarla.
La dificultad o cuadrícula quedan en el snapshot y en data de MATCH_STARTED
como `difficulty` o `gridSize`.

| Ruta | Uso |
| --- | --- |
| GET /api/health | Salud de Node, sin prometer salud de dependencias. |
| GET /api/catalog | Los tres juegos disponibles. |
| GET /api/matches | Partidas locales y estado de envío. |
| GET /api/matches/{id} | Snapshot de una partida. |
| POST /api/matches/{id}/action | Acción del jugador o avance del juego. |
| POST /api/matches/{id}/finish | Cierre por abandono, sin duplicar el cierre. |
| GET /api/matches/{id}/results | Resultados de GameStats para esa instancia. |
| GET /api/dashboard | Resumen de GameStats. |

Los eventos mantienen `schemaVersion:1`, eventId, timestamp, gameId, matchId,
type y data, más gameVersion y playerId cuando corresponden. La versión de
juego 1.1 es independiente de la versión del sobre y del perfil analítico.
Todos generan inicio y cierre. Gato agrega MOVE_PLACED y AI_DECISION; Snake,
APPLE_EATEN y PLAYER_DIED; Circuito, LAP_COMPLETED y OBSTACLE_HIT.
Snake envía incrementos, nunca el acumulado como si fueran puntos nuevos.
Los datos adicionales de configuración no requieren modificar GameStats.

GameStats Go recibe POST /events y ofrece GET /results/{gameId}/{matchId}.
El resumen de GET /dashboard se calcula en Scala mediante POST /analyze-summary.
Se suman métricas aditivas con unidades compatibles y no se promedian promedios.
Las consultas repetidas no acumulan valores de consultas anteriores.

## Fallos y limitaciones conocidas

- Cada partida tiene UUID, estado y cola propios. `exclusive` serializa sus
  acciones y evita que dos solicitudes modifiquen su estado a la vez.
- El inicio se entrega antes que sus acciones y el cierre después. Otras
  partidas pueden seguir enviando; no esperan esa misma cola.
- Los fallos temporales se reintentan con espera creciente. Un 409 solo se
  reconoce como duplicado entregado si GameStats confirma el mismo eventId.
- Partidas y colas están en memoria. Reiniciar Node o Go elimina sus datos;
  no existe recuperación durable ni garantía de entrega exactamente una vez.
- Reiniciar solo Go durante una partida pierde el inicio ya recibido: para
  continuar sin conflictos, se necesita una sesión nueva del entorno.
- GameConsole admite hasta 500 instancias por sesión. GameStats conserva sus
  límites por partida y el snapshot agregado está limitado a 8 MiB.
- El resumen tiene snapshots consistentes por partida, sin transacción global
  entre todas. Los datos inválidos se señalan como parciales.
- Una misma instancia abierta en dos clientes no tiene control de propietario.
  Para demostrar concurrencia, iniciar partidas con identificadores diferentes.
- No hay cuentas, PvP, almacenamiento histórico, alojamiento remoto o soporte
  ARM64 comprobado. No se añaden como requisitos implícitos.

## Configuración de desarrollo

| Variable | Valor habitual | Uso |
| --- | --- | --- |
| PORT | 3000 | Puerto de GameConsole. |
| HOST | 127.0.0.1 | Dirección de escucha de Node fuera de Docker. |
| GAMESTATS_URL | http://127.0.0.1:8080 | Destino de Go; Compose usa el nombre interno del servicio. |
| SWIPL_PATH | swipl | Ruta del intérprete si no está en PATH. |
| GAMESTATS_PORT | 8080 | Puerto publicado por Go en Compose. |
| GAMESTATS_SOURCE | ./.deps/gamestats | Contexto para Compose directo. |
| CONSOLE_URL | http://127.0.0.1:3000 | Destino de las pruebas integradas. |

En PowerShell, por ejemplo: `$env:PORT='3001'`. En CMD: `set PORT=3001`.
No se requieren cambios globales. Para desarrollar la consola sin contenedor
y conservar Go/Scala en Docker, preparar la dependencia y ejecutar:

```sh
docker compose up -d --build --wait scala-analysis go-ingestion
npm start
```

## Verificación y entrega automatizada

Las pruebas incluyen configuración y límites de cuadrícula, las tres
dificultades con Prolog real, una victoria humana en baja y la exploración
exhaustiva de continuaciones humanas para comprobar que alta no pierde.
También se prueban API, aislamiento, errores, reintentos y duplicados.

`node scripts/recovery.mjs` pausa temporalmente el contenedor Go del proyecto,
comprueba que se conserve el envío pendiente y lo reanuda. Ejecutarlo solo
en el entorno local de pruebas. Los informes quedan en `evidence/`.

Actions ejecuta las pruebas, construye y levanta Docker, corre las seis
partidas y la recuperación, adjunta informes y detiene su entorno temporal.
Es preparación y verificación de la entrega; no publica una web en Internet.
GameStats conserva su CI propia con Go, detector de carreras, Scala y sus
pruebas originales de integración.

## Ruta de continuación para Justin

1. Obtén acceso al repositorio privado, clónalo y lee este README.
2. Ejecuta `node scripts/deploy.mjs` y prueba opciones e instrucciones.
3. Revisa el panel mientras una partida permanece abierta y comprueba que los
   resultados correspondan al juego y la instancia correctos.
4. Para reglas, empieza por `server/games.mjs`; para IA, `prolog/gato.pl`;
   para presentación y diálogo, `public/`.
5. Conserva la separación de responsabilidades: estadísticas en Scala,
   recepción en Go y reglas/decisiones en GameConsole/Prolog.
6. Trabaja en una rama propia, conserva el historial y revisa Actions antes
   de fusionar. Un cambio de contrato debe documentarse y probarse.
7. Si cambias GameStats, utiliza su repositorio principal de desarrollo y
   actualiza el SHA fijado únicamente después de verificar esa versión.

### Pendientes para cerrar el proyecto

- Confirmar con el docente cualquier indicación adicional sobre dos jugadores.
- Revisar y fusionar el PR #17 de GameStats según acuerden los integrantes.
- Revisar experiencia de juego, nombres de autores y enlaces.
- Grabar y publicar el video con acceso público. El guion propone 8–12 minutos
  con juegos, Prolog, concurrencia, estadísticas, Docker y pruebas.
- Realizar la entrega en Tec Digital. El enunciado indica viernes 20 de
  noviembre de 2026, antes de las 10:00 p. m., hora de Costa Rica.

## Resolución de problemas

| Problema | Qué revisar |
| --- | --- |
| No conecta Docker | Abrir Docker Desktop y esperar al motor Linux. |
| Puerto ocupado | Cambiar PORT/GAMESTATS_PORT o detener el servicio que lo usa. |
| Error por tildes | Usar el preparador deploy.mjs, que construye en una copia sin tildes. |
| GameStats desconectado | Revisar salud, logs y commit fijado; una versión anterior puede carecer de /dashboard. |
| Prolog falla fuera de Docker | Comprobar swipl --version y SWIPL_PATH; ejecutar gato_tests.pl. |
| Cambios no visibles | Reconstruir la imagen y recargar la página. |
| Cambios locales en .deps | Conservarlos antes de preparar; el script se niega a sobrescribirlos. |
| No se puede clonar | Comprobar acceso de la cuenta al repositorio privado. |
