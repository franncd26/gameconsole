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

No es necesario instalar Go, Scala ni SWI-Prolog en el equipo anfitrión: se incluyen en los contenedores. El repositorio **GameStats** se prepara automáticamente en la revisión indicada en `gamestats.lock.json`. Para clonar los repositorios privados se requiere acceso autorizado a GitHub.

## Instalación y deployment

Desde PowerShell o una terminal con Node y Docker disponibles:

```powershell
git clone https://github.com/JusMH/gameconsole.git
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

## Uso de la consola

1. Seleccionar un videojuego en **Biblioteca**, configurar sus opciones y crear una partida.
2. Jugar desde su panel. Es posible abrir otras partidas, incluso del mismo juego, sin reemplazar las anteriores.
3. Utilizar **Cuadrícula** para observar varias partidas a la vez. Cada una mantiene sus controles, estado y estadísticas.
4. Consultar las estadísticas del juego y el panel general mientras las partidas continúan. Los valores provienen de GameStats.
5. Al completar o finalizar una partida, consultar su resultado en el historial.

Una partida también puede abrirse en otra pestaña mediante `/?match=<id>`; se muestra la **misma** partida, no una nueva. El control entre pestañas se coordina mediante Web Locks cuando el navegador lo permite.

En Snake y Circuito, **Jugar / Pausa / Continuar** controla la actividad del cliente. Las preferencias de suspensión al ocultar la página están disponibles en **Ajustes**. Los atajos **Ctrl+Alt+J/K** permiten cambiar el juego enfocado, si el navegador no los reserva.

## Pruebas y CI/CD

Para las pruebas locales se necesita Node.js 22 y SWI-Prolog disponible en el equipo. Python 3 solo es necesario para las pruebas del importador opcional.

```powershell
npm run check
npm test
```

Con los tres servicios ya iniciados y sin partidas concurrentes durante la prueba:

```powershell
npm run test:integration:sdk
```

El comando de integración verifica la creación de partidas, decisiones de Prolog, entrega de eventos a Go, resultados provisionales y finales de Scala y conteos del panel general. Genera `evidence/sdk-integration.json`.

El pipeline de GitHub Actions ejecuta las pruebas, construye Docker y realiza una integración con los servicios reales. La [ejecución de verificación](https://github.com/JusMH/gameconsole/actions/runs/44814482222) finalizó correctamente; sus trabajos `verify` e `integrated` están aprobados.

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
