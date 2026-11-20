# GameConsole

**Proyecto 2 — Lenguajes de Programación, Instituto Tecnológico de Costa Rica**  
**Integrantes:** Francisco Castillo y Justin.

GameConsole es una consola web que permite ejecutar videojuegos de manera concurrente y consultar sus estadísticas durante las partidas. Los juegos utilizan programación orientada a objetos; uno de ellos incorpora un oponente que toma decisiones mediante Prolog. Los eventos se envían a GameStats, donde Go los recibe y Scala calcula las métricas.

## Videojuegos incluidos

La configuración de entrega contiene **exactamente tres juegos**:

| Juego | Descripción | Controles |
| --- | --- | --- |
| **Gato** | Tres dificultades; el oponente utiliza reglas y minimax en SWI-Prolog. | Ratón o Tab/Enter para colocar X. |
| **Snake** | Movimiento, comida, crecimiento y colisiones; tableros de 12, 20 o 28 casillas por lado. | Flechas, WASD o controles en pantalla. |
| **Circuito** | Carrera de tres carriles con obstáculos, aceleración, frenado y tres vueltas. | A/D o izquierda/derecha para cambiar de carril; W/arriba para acelerar y S/abajo para frenar. |

## Requisitos

- Git, **Node.js 22** y Docker Engine o Docker Desktop con contenedores Linux.
- Docker Compose v2, compatible con `up --wait`.
- Conexión a Internet durante la primera construcción, para obtener imágenes y dependencias.

Antes de comenzar, iniciar Docker Desktop o Docker Engine y comprobar que `node --version` y `docker compose version` funcionan. La versión principal de Node debe ser **22**.

No es necesario instalar Go, Scala ni SWI-Prolog en el equipo anfitrión **para ejecutar la consola**: se incluyen en los contenedores. GameStats se prepara automáticamente desde su [repositorio público](https://github.com/JusMH/gamestats), utilizando la revisión indicada en `gamestats.lock.json`. Tanto GameConsole como GameStats son públicos y pueden clonarse sin credenciales de GitHub.

## Instalación y deployment

Desde PowerShell o una terminal con Node y Docker disponibles:

```powershell
git clone https://github.com/franncd26/gameconsole.git
cd gameconsole
node scripts/deploy.mjs
```

El script prepara la dependencia GameStats, construye los contenedores y espera a que los servicios alcancen un estado saludable.

| Servicio | Función | Acceso |
| --- | --- | --- |
| `gameconsole` | Consola web, reglas de los juegos y SWI-Prolog. | http://127.0.0.1:3000 |
| `go-ingestion` | Recepción y consultas de eventos de GameStats. | http://127.0.0.1:8080 |
| `scala-analysis` | Cálculo de estadísticas y patrones. | Puerto interno 9000 de Docker. |

Abrir **http://127.0.0.1:3000/**. La biblioteca debe presentar Gato, Snake y Circuito.

Para consultar el estado del despliegue:

```powershell
docker compose -p gameconsole ps
```

Para detenerlo:

```powershell
node scripts/deploy.mjs --stop
```

El deployment es reproducible mediante Docker Compose **en un entorno local**; no requiere un sitio web alojado públicamente. Se pueden ajustar los puertos expuestos con `PORT` y `GAMESTATS_PORT`.

## Verificación rápida de la instalación

Estas comprobaciones permiten evaluar el funcionamiento sin instalar Go, Scala ni Prolog en el equipo anfitrión:

1. Ejecutar `docker compose -p gameconsole ps` y confirmar que los tres servicios (`gameconsole`, `go-ingestion`, `scala-analysis`) están saludables.
2. Abrir **http://127.0.0.1:3000/** y comprobar que **Biblioteca** muestra exactamente **Gato, Snake y Circuito**.
3. Iniciar **Gato** en dificultad alta, colocar una X y observar la respuesta de la computadora, calculada mediante Prolog.
4. Iniciar partidas de **Snake** y **Circuito**, entrar en **Partidas → Cuadrícula** y comprobar que funcionan simultáneamente. Se pueden crear también varias instancias de un mismo videojuego.
5. Consultar las estadísticas de una partida y abrir la sección **Estadísticas** para comprobar los resultados generales y por videojuego. Los valores se actualizan periódicamente mientras se generan eventos.

Para una validación automatizada con los servicios reales, consultar la sección de pruebas. Ejecutarla **sin otras partidas abiertas ni productores de eventos simultáneos**, porque crea y finaliza partidas de prueba.

## Uso de la consola

1. Seleccionar un videojuego en **Biblioteca**, configurar sus opciones y crear una partida.
2. Jugar desde su panel. Es posible abrir otras partidas, incluso del mismo juego, sin reemplazar las anteriores.
3. Utilizar **Cuadrícula** para observar varias partidas a la vez. Cada una mantiene sus controles, estado y estadísticas.
4. Consultar las estadísticas del juego y el panel general mientras las partidas continúan. Los valores provienen de GameStats.
5. Al completar o finalizar una partida, consultar su resultado en el historial.

Una partida también puede abrirse en otra pestaña mediante `/?match=<id>`; se muestra la **misma** partida, no una nueva. El control entre pestañas se coordina mediante Web Locks cuando el navegador lo permite.

En Snake y Circuito, **Jugar / Pausa / Continuar** controla la actividad del cliente. Las preferencias de suspensión al ocultar la página están disponibles en **Ajustes**. Los atajos **Ctrl+Alt+J/K** permiten cambiar el juego enfocado, si el navegador no los reserva.

## Pruebas y CI/CD

Las pruebas automatizadas son **opcionales para utilizar la consola**. Para evaluar los tres juegos en el navegador es suficiente con seguir el deployment y la verificación rápida.

- `npm run check` requiere Node.js 22 y comprueba la sintaxis.
- `npm test` requiere Node.js 22, **SWI-Prolog** en `PATH` (o `SWIPL_PATH`) y **Python 3** para las pruebas de paquetes ZIP del importador. Estas son dependencias de las pruebas locales, no de los videojuegos ejecutados en Docker.
- `npm run test:integration:sdk` comprueba el sistema real con los tres servicios Docker **ya iniciados y saludables**. Prolog se ejecuta dentro de su contenedor; no requiere instalarlo en el equipo anfitrión.

```powershell
npm run check
npm test
```

Con los tres servicios ya iniciados y sin partidas concurrentes durante la prueba:

```powershell
npm run test:integration:sdk
```

El comando de integración verifica la creación de partidas, decisiones de Prolog, entrega de eventos a Go, resultados provisionales y finales de Scala y conteos del panel general. Genera `evidence/sdk-integration.json`.

El pipeline de GitHub Actions ejecuta las pruebas, construye Docker y realiza una integración con los servicios reales. La [ejecución de verificación del repositorio original](https://github.com/franncd26/gameconsole/actions/runs/44819352482) finalizó correctamente; sus trabajos `verify` e `integrated` están aprobados.

## Solución de problemas habituales

| Situación | Qué comprobar |
| --- | --- |
| `docker` no se reconoce o no conecta con el servicio. | Iniciar Docker Desktop o Docker Engine y ejecutar `docker info` y `docker compose version`. En Windows, utilizar contenedores Linux. |
| Error de puerto en uso durante el despliegue. | Cerrar el servicio que utiliza ese puerto o cambiar los puertos publicados antes del arranque. |
| No se puede preparar GameStats. | Comprobar Internet y el acceso al [repositorio público de GameStats](https://github.com/JusMH/gamestats). El script descarga automáticamente la revisión requerida. |
| No aparecen estadísticas inmediatamente. | Generar eventos jugando, esperar la consulta periódica y confirmar que los tres servicios continúan saludables. |
| Alguna prueba local indica que falta Prolog o Python. | Instalar las dependencias de pruebas indicadas arriba, o utilizar la demostración Docker y la evidencia de GitHub Actions. |

En **PowerShell**, para cambiar los puertos publicados antes de iniciar:

```powershell
$env:PORT="3002"
$env:GAMESTATS_PORT="8082"
node scripts/deploy.mjs
```

En este ejemplo, GameConsole se abre en `http://127.0.0.1:3002/`. Estos cambios no alteran la comunicación interna de los contenedores.

Para inspeccionar los últimos mensajes de los servicios:

```powershell
docker compose -p gameconsole logs --tail=100
```

Para detener el entorno, ejecutar `node scripts/deploy.mjs --stop`.

## Diseño y limitaciones

La consola separa los módulos de juego, las sesiones, el envío de eventos y la visualización estadística. Las operaciones de cada partida se ordenan de forma independiente; **EventOutbox** entrega sus eventos a GameStats sin bloquear las demás partidas. Scala es responsable de calcular las estadísticas; el navegador únicamente las consulta y presenta.

Las partidas y los eventos aún pendientes residen en memoria: no sobreviven al reinicio de sus respectivos procesos. Tampoco se implementan cuentas ni control global de jugadores entre equipos.

Existe un **importador experimental opcional** para paquetes confiables `.game.zip`, separado del deployment académico de tres juegos. Su uso no es necesario para ejecutar ni evaluar los requisitos del proyecto.

## Documentación

- [Arquitectura y decisiones técnicas](docs/arquitectura.md)
- [Eventos, servicios y consultas de GameStats](docs/integracion.md)
- [Verificación del proyecto](docs/entrega.md)
- [Guion de demostración](docs/video.md)
- [Contrato del SDK (consulta complementaria)](docs/sdk-v1/README.md)
- [Repositorio de GameStats](https://github.com/JusMH/gamestats)
