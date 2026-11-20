# Fase 3E.2 — Interfaces jugables independientes

> **Informe histórico de etapa.** Los alcances, comandos y verificaciones siguientes
> corresponden a esta fase; no son la guía de despliegue vigente. Consultar el
> [README principal](../../README.md) y el [estado de entrega](../entrega.md).

La política de foco descrita en esta fase histórica fue sustituida por
[3H](phase-3h-game-experience.md): blur libera entradas sin desarmar, la consola
comunica visibilidad y preferencias, y el control se coordina entre pestañas.

Base: `f1c0eef78720dee7396d97f94c591776dc5ee838`, rama
`feature/gameconsole-sdk-v1`. Esta fase modifica exclusivamente los recursos web
de los tres paquetes, añade pruebas y documentación. La consola histórica,
Bridge v1, las sesiones, las reglas, los manifiestos y los perfiles no cambian.
No completa la entrega global de GameConsole.

## Estructura y responsabilidades

Cada `plugins/<gameId>/web/` contiene:

| Archivo | Responsabilidad |
| --- | --- |
| `index.html` | Documento accesible con controles, estado y referencias relativas. |
| `app.mjs` | Composición de cliente Bridge, controlador y vista del paquete. |
| `controller.mjs` | Entradas, admisión de una acción, resincronización y ciclo de vida de la página. |
| `view.mjs` | Clase `GatoView`, `SnakeView` o `RacingView`: representación de snapshots y eventos DOM. |
| `styles.css` | Tema oscuro propio, controles compactos y adaptación del iframe. |

Los controladores `GatoController`, `SnakeController` y `RacingController` reciben
Bridge, vista, ventana, documento, reloj de temporizadores y generador de
messageId inyectables. Son implementaciones independientes: ningún juego importa
otro paquete ni un motor web común. Las pruebas sustituyen esos límites sin
instalar DOM, navegador o dependencias npm.

La única importación pública ajena al paquete es
`/sdk/bridge/game-client.mjs`. No hay fetch, HTTP SDK directo, acceso al DOM padre,
Node, GameStats ni publicación de eventos desde las interfaces. El servidor es
la autoridad sobre identidad, versiones, reglas, puntuaciones, colisiones,
tiempo físico, IA y resultados. Las copias locales son exclusivamente de lectura
y presentación. La consola sigue creando y cerrando administrativamente partidas.

## Contratos y controles

### Gato

`PLACE_MARK`, payload exacto `{index}`; `RETRY_AI`, payload exacto `{}`.
La dificultad se muestra desde `data.difficulty`, sin modificar la opción de la
partida. Tab + Enter o un clic seleccionan una de nueve casillas accesibles.
Se muestran `board`, `turn`, `awaitingAI`, `winningLine` y `result`; el navegador
no calcula ganadores ni decide jugadas de Prolog. X y O proceden del snapshot.

Una casilla ocupada, una operación pendiente, una IA pendiente, la desconexión o
un lifecycle distinto de running deshabilitan el tablero. Durante el despacho
se muestra la espera por Prolog. Un fallo parcial conserva la X confirmada:
tras obtener el snapshot vigente, `awaitingAI=true` habilita **Reintentar IA**.
Ese botón inicia una operación nueva `RETRY_AI`, nunca otra X. Un replay manual
de una operación de resultado desconocido conserva su messageId original.

Se representan `human_won`, `prolog_won`, `draw`, la línea ganadora y el cierre
administrativo sin inventar un resultado de dominio. `lastDecision` permanece en
el snapshot; no se reinterpreta para producir movimientos en el navegador.

### Snake

`TICK`, payload exacto `{direction}`, con up/down/left/right. Flechas, WASD y
cuatro botones cambian únicamente una intención local de dirección. El servidor
resuelve las inversiones, el avance, las colisiones y la comida.

Canvas 2D representa `size`, `body` y `food` para cuadrículas 12/20/28. Cabeza,
cuerpo y manzana tienen colores distintos. `points` se presenta sin acumulación
local; `game_over` y `board_completed` detienen el movimiento y muestran resultado.

**Jugar / continuar** consulta primero el estado. Luego programa un TICK a los
150 ms, espera despacho y snapshot, y solo entonces programa el siguiente. No
es una frecuencia física garantizada: con latencia, el juego avanza más despacio;
no hay ráfagas para compensar movimientos atrasados ni dos TICK en vuelo.

### Circuito

`STEP`, payload exacto `{lane, accelerate, brake}`. Izquierda/derecha o A/D
seleccionan intención de carril; arriba/W acelera y abajo/S frena mientras se
mantienen pulsados. Hay botones de carril y pedales con pointer capture,
liberación por pointerup/cancel y alternativas Enter/espacio. La selección local
de carril solo restringe la entrada a 0/1/2, sin cambiar el carril dibujado hasta
recibir confirmación del servidor.

**Activar controles** consulta primero el estado y comienza un STEP por ciclo de
180 ms, siempre después de completar la operación anterior y resincronizar.
No se envían dt, velocidad ni timestamps. Se muestran carril confirmado,
obstáculos relativos a progress, velocidad redondeada solo para presentación,
colisiones, `lapTimes` en segundos y vueltas **completadas** desde `0 / 3`.
La pista no simula física ni calcula choques. Un aumento confirmado de colisiones
resalta el borde durante esa versión pública. `race_completed` presenta el final.

## Observación, versiones y fallos

Los controladores usan onInit/onSnapshot/onResult/onError/onDetach, getSnapshot,
requestSnapshot, dispatch y dispose. El observador no adopta snapshots de otra
identidad ni versiones menores. ACTION_RESULT puede contener el resultado
original de un replay; **su snapshot no se usa para dibujar**. Después del
resultado se pide el snapshot actual y se lee también la copia vigente del cliente.

Hay una guardia busy por interfaz que cubre despacho y resincronización. No se
añade una cola de ejecución. Los controles de dirección pueden conservar una
intención para el siguiente paso, sin acumular acciones. Consultar estado durante
el movimiento cancela el temporizador pendiente y programa solo uno al concluir.

- completed: resultado conocido; se consulta el estado antes de continuar.
- rejected: se informa el código y se detiene la emisión automática. Un
  VERSION_CONFLICT se resincroniza, sin ejecutar de nuevo la misma intención con
  otra versión automáticamente.
- dependency_failed: se distingue si hubo confirmaciones. Se conserva el estado
  aceptado; no se promete rollback. En Gato puede habilitarse RETRY_AI.
- RESULT_UNKNOWN o error con unknown: se detiene el bucle y se conserva la
  operación con su messageId y payload. **Consultar estado** no repite la acción
  ni resuelve por sí solo su incertidumbre. **Recuperar misma operación** es un
  replay explícito con el mismo identificador mientras la sesión siga running.
  No se genera un messageId nuevo para ese intento ni se habilitan acciones nuevas
  hasta obtener un resultado conocido. En una partida cerrada se consulta el
  estado; el botón de replay queda deshabilitado.
- Si falla la consulta posterior a un resultado conocido, se bloquean nuevas
  decisiones hasta una resincronización correcta. Nunca se repite por ello una
  acción ya confirmada.
- Desconexión o mensaje excesivo: no se fracciona el snapshot ni se oculta el
  fallo. Se indica consultar/remontar desde la consola; no hay timeout que finja
  cancelar una operación del servidor.

La idempotencia sigue dependiendo de las ventanas acotadas existentes del Bridge
y SDK, del canal vigente y de la memoria del proceso. No se promete persistencia
ni deduplicación después de expulsiones, reinicios o un nuevo iframe.

## Foco y desmontaje

Blur o una pestaña oculta limpian las entradas y detienen los temporizadores.
Una acción ya enviada puede confirmarse igualmente. No se describe esta suspensión
local de entradas como pause/resume del SDK: los manifiestos no lo habilitan.

Al volver, Snake y Circuito requieren pulsar Jugar/continuar o Activar controles;
esa pulsación resincroniza antes de reanudar. El foco por sí solo no reinicia la
simulación. Esto evita consumir el primer clic por una lectura simultánea. Gato
resincroniza al recuperar foco cuando sea necesario. Pagehide y DETACH limpian
temporizadores, listeners DOM, suscripciones y cliente Bridge. Las respuestas
tardías no vuelven a dibujar ni a programar pasos después de dispose.

Una navegación/recarga no reconecta el iframe: sigue siendo necesario un elemento
nuevo montado por el host. No hay controles para navegar o crear partidas dentro
del juego.

## Recursos, CSP y sandbox

Solo se utilizan HTML, CSS externo, ESM externo y Canvas 2D. No hay CDN, recursos
remotos, scripts/estilos inline, handlers HTML, dependencias ni cambios de CSP.
Las rutas relativas quedan dentro del árbol web confiable, y el cliente público
se importa por su ruta estable. Todos los archivos están por debajo de 1 MiB.
Continúan sandbox allow-scripts, origen opaco y el CORS limitado a assets públicos
de la fase anterior; la API no abre CORS al iframe. El diseño es compacto para
600×360, con ajuste a mayor tamaño y apilado en pantallas estrechas. Mensajes
largos pueden requerir scroll; no se recortan errores para ocultarlos.

## Verificación automatizada

Suites nuevas:

```powershell
node --test test/sdk-gato-web.test.mjs test/sdk-snake-web.test.mjs test/sdk-racing-web.test.mjs test/sdk-web-game-integration.test.mjs
```

20 pruebas nuevas cubren vistas con DOM/Canvas simulados, entradas, snapshots,
líneas/resultados, espera y fallo parcial de IA, replay manual, versiones,
latencia, foco, limpieza y canales independientes. La integración conecta las
tres vistas/controladores con GameBridgeClient → HostBridge → HTTP local → SDK
y plugins auténticos, usando EventOutbox real y aceptación Go simulada. Gato
permanece abierto sin despachar acciones que invocarían Prolog.

La regresión explícita de 22 archivos incluye esas cuatro suites, assets y las
tres suites Bridge, SDK v1/runtime/lifecycle/transitions/actions/outbox/http,
SDK Gato/Snake/Racing/multigame/shutdown y HTTP/Outbox históricos: **217 pruebas
aprobadas, 0 fallos, 0 skips**. No se ejecuta `test/games.test.mjs` ni npm test.
Los 14 archivos ESM nuevos (nueve web y cinco de pruebas/helper) pasan node --check.

## Comprobación breve en navegador y reproducción

```powershell
node scripts/sdk-bridge-demo.mjs
```

Abrir la URL loopback que imprime; la demo tiene límite de cinco minutos y Go
simulado. No inicia Go/Scala/Docker. El texto introductorio del harness sigue
siendo el histórico de 3E.1; las páginas embebidas son ahora las interfaces de
esta fase. No se modifica el harness ni la consola histórica para corregir ese
texto fuera del alcance.

1. Seleccionar cada plugin del catálogo y usar Crear y montar una vez por juego.
2. Gato: verificar tablero, dificultad e identidad. Para una partida auténtica,
   el equipo debe tener SWI-Prolog instalado; seleccionar una casilla y comprobar
   X/O, estado terminal y recuperación cuando corresponda.
3. Snake: pulsar Jugar/continuar, dirigir con flechas/WASD o botones y comprobar
   puntos/terminal. Al cambiar de iframe el movimiento se suspende; volver a
   pulsar continuar consulta el estado antes de emitir otro paso.
4. Circuito: activar controles, mantener acelerar/frenar y cambiar carril.
   Comprobar velocidad, choques y vueltas sin enviar tiempos desde el cliente.
5. Desmontar únicamente un iframe; los otros siguen vinculados. Montar de nuevo
   crea un canal nuevo y recupera el snapshot existente; no crea otra partida.
6. Usar Finalizar partida en el host: la vista cerrada no debe emitir pasos.
   Comprobar consola del navegador sin errores CSP/CORS/ESM.
7. Cerrar con Ctrl+C; la demo también se apaga automáticamente a los cinco minutos.

Se realizó **una comprobación breve en el navegador integrado**, sin instalaciones:
los tres iframes cargaron y recibieron INIT. Circuito aceleró hasta una velocidad
confirmada de 60 y alcanzó v7; siguió recibiendo pasos hasta perder foco. Snake
se activó con un clic tras corregir el manejo de foco, avanzó y terminó por choque
en v15, con controles deshabilitados. Desmontarlo y remontarlo recuperó finished;
Gato permaneció running v0 y Circuito mantuvo su identidad independiente. El
registro de consola consultado no mostró errores ni avisos. Se guardó una sola
captura conjunta. La demo se cerró y el proceso terminó correctamente.

No se pulsaron casillas de Gato ni se ejecutó SWI-Prolog. Los controles de dirección
Snake, recuperación de IA, final de carrera y demás variantes se verifican mediante
los dobles automatizados; la partida auténtica de Gato, pruebas táctiles en un
dispositivo real, accesibilidad con lector de pantalla y una carrera completa
en navegador quedan para el equipo. Esta comprobación no demuestra entrega real
a Go/Scala: su transporte fue simulado.

## Pendientes

3E.3 debe integrar la consola visual, creación genérica con opciones, observación
del cierre administrativo y estadísticas en vivo. Siguen pendientes la política
de múltiples instancias del mismo juego, empaquetado/despliegue, Docker y CI/CD.
No se instalaron herramientas de navegador, no se hicieron pruebas de carga ni
capturas repetitivas, ni se ejecutaron servicios externos o integración pesada.
