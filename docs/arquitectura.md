# Arquitectura y decisiones

La aplicación utiliza módulos JavaScript nativos, Node.js 22 y SWI-Prolog.
No necesita un framework ni paquetes npm para sus funcionalidades. Es una
elección de alcance: tres juegos pequeños, integración HTTP y entrega Docker.

```text
Navegadores independientes
    │ HTTP mismo origen
    ▼
GameConsole Node.js ── entrada/salida JSON ── SWI-Prolog / minimax
    │ cola ordenada por partida
    │ POST /events
    ▼
GameStats Go ── snapshots HTTP ── GameStats Scala
    ▲                                  │
    └──── estadísticas de partida y resumen
```

## Orientación a objetos

`Match` abstrae identidad, estado, eventos y ciclo de vida. `TicTacToe`, `Snake`
y `Racing` encapsulan reglas y estado, especializan `action` y `snapshot` y
comparten inicio/cierre mediante herencia justificada. `EventOutbox` separa el
transporte del dominio. `GameConsole` coordina la interfaz y sus controles.
Los snapshots son copias para que el consumidor no modifique el estado interno.
Las solicitudes de una misma partida se serializan con `exclusive`; las demás
partidas progresan independientemente. El servidor mantiene las reglas y la IA.

## Prolog

Los tres niveles se ejecutan en Prolog: baja toma una victoria inmediata o una
casilla libre; media agrega bloqueo de amenazas y preferencia por el centro;
alta conserva minimax completo. No hay selección aleatoria de movimientos.
La configuración se registra en MATCH_STARTED y la interfaz propone media.

El tablero se representa con nueve átomos: X, O y e. Las reglas reconocen líneas
ganadoras, generan movimientos legales y exploran estados alternando jugadores.
Minimax maximiza para O y minimiza para X: victoria O = 10, empate = 0,
victoria X = -10. Una preferencia centro/esquinas/bordes desempata decisiones
óptimas. Tabling memoriza subproblemas dentro de la consulta.

Node ejecuta el intérprete con argumentos fijos, sin shell ni código construido
con datos del usuario. Envía JSON por stdin y consume la respuesta por stdout.
Hay timeout y validación de la casilla devuelta. Si falla la IA, el movimiento
humano se conserva y la interfaz permite reintentar el turno de Prolog.

Referencias: [JSON en SWI-Prolog](https://www.swi-prolog.org/pldoc/man?section=json)
y [procesos de Node.js](https://nodejs.org/api/child_process.html).

## Concurrencia y fallos

Cada partida usa UUID, estado propio y cola de eventos independiente. El inicio
se entrega antes de sus acciones y el cierre después de ellas. No se espera la
red de GameStats para continuar jugando. Los reintentos usan espera creciente;
un 409 solo se reconoce como duplicado entregado si GameStats confirma el ID.
Una caída mantiene los eventos pendientes en memoria mientras vive Node.

El almacenamiento en memoria no garantiza recuperación ante reinicio o apagado.
No se promete entrega exactamente una vez. Reiniciar Go durante partidas requiere
una nueva sesión: su historial previo y su ciclo de vida se pierden.

El resumen se calcula en Scala, sobre una colección consistente por partida,
sin transacción global entre todas ellas. No se promedian promedios ni se suman
métricas de unidades diferentes. Los datos inválidos se señalan como parciales.
La consola presenta estos resultados, sin recalcularlos.

## Alcance y límites

Gato aplica las reglas completas del juego; GameStats analiza evidencia.
Snake registra comida y muerte, sin enviar cada fotograma. Circuito registra
vueltas y choques, sin usar GameStats como reloj o motor de física.
El servidor admite hasta 500 partidas por sesión; el resumen está limitado a
8 MiB y cada partida respeta los límites propios de GameStats.
No se incorporan cuentas, multijugador remoto, base de datos o servicios de pago.
