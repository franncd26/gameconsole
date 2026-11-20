# Verificación y entrega

**Proyecto 2 — Lenguajes de Programación, TEC**

La entrega incluye el código fuente de GameConsole, los tres juegos (Gato, Snake y Circuito), la lógica Prolog, los contratos de integración con GameStats, la configuración Docker y el pipeline de CI/CD.

## Comprobaciones técnicas

| Requisito | Evidencia |
| --- | --- |
| Tres juegos web con POO | Paquetes independientes con clases de reglas y sesiones. |
| Inteligencia Prolog | Gato usa SWI-Prolog para elegir jugadas; se comprueba con pruebas automatizadas e integración. |
| Partidas concurrentes | Identificadores de partida distintos, estado aislado y operaciones serializadas por instancia. |
| Eventos compatibles | Contrato GameStats v1 y envío ordenado a Go mediante EventOutbox. |
| Estadísticas durante el juego | Consultas por partida y dashboard general obtenidos de GameStats Go/Scala. |
| Construcción y deployment | Docker Compose inicia consola, Go y Scala, con Prolog integrado en el servicio Node. |
| CI/CD | Workflow que verifica pruebas y sintaxis, construye imágenes y ejecuta la integración real. |

## Resultados de CI/CD

La [ejecución de GitHub Actions del 20 de noviembre de 2026](https://github.com/JusMH/gameconsole/actions/runs/44814482222) finalizó correctamente.

- **Verificación:** 342 pruebas Node aprobadas, sin fallos ni cancelaciones, junto con las pruebas de Prolog.
- **Integración:** construcción y arranque de los tres servicios Docker, comprobación de los tres juegos, decisión real en Prolog y consulta de resultados Go/Scala.
- **Resultado del ejecutor integrado:** `status: passed`.
- **Evidencia:** [artefacto sdk-integration](https://github.com/JusMH/gameconsole/actions/runs/44814482222/artifacts/14669531219).

Estas pruebas automatizadas no sustituyen la demostración visual de los juegos y su interfaz.

## Reproducción del sistema

```powershell
git clone https://github.com/JusMH/gameconsole.git
cd gameconsole
node scripts/deploy.mjs
```

Abrir `http://127.0.0.1:3000/`. El catálogo académico presenta exactamente tres juegos. Para detener el entorno:

```powershell
node scripts/deploy.mjs --stop
```

Las instrucciones de uso, requisitos y pruebas locales están en el [README](../README.md); la justificación técnica se encuentra en [arquitectura](arquitectura.md) e [integración](integracion.md).

## Demostración en video

El video debe mostrar Gato contra Prolog, Snake, Circuito, partidas simultáneas, eventos y estadísticas generales y por juego obtenidas de GameStats. La duración prevista es inferior a 15 minutos.

**Enlace público del video:** pendiente de incorporar al finalizar su publicación.

## Alcance y limitaciones

El deployment se realiza con Docker Compose en un entorno local. Las partidas y los eventos pendientes residen en memoria y no se conservan tras reiniciar los procesos.

La configuración de entrega contiene tres juegos. El importador opcional de otros paquetes es una extensión separada y no modifica ese catálogo académico.

**Herramientas de apoyo:** se utilizó Codex como asistencia durante el desarrollo y revisión; las decisiones, pruebas y responsabilidad de la entrega corresponden al equipo.
