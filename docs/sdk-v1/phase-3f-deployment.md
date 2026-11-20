# Fase 3F — Despliegue local, CI e integración SDK

> **Informe histórico de etapa.** Los alcances, comandos y verificaciones siguientes
> corresponden a esta fase; no son la guía de despliegue vigente. Consultar el
> [README principal](../../README.md) y el [estado de entrega](../entrega.md).

Base inspeccionada: `a8fca405cfeb43d074fc889ac65f7f0c31964906`, rama
`feature/gameconsole-sdk-v1`, árbol limpio antes de editar. El remoto de
GameConsole está configurado como `https://github.com/JusMH/gameconsole.git`;
se corrigieron las referencias antiguas del README con esa evidencia local.
No se certifica acceso público al repositorio ni una ejecución nueva de Actions.

## IMPLEMENTADO y comprobado de forma ligera

- Dockerfile añade únicamente COPY plugins con propietario node:node. Conserva
  Node 22, SWI-Prolog, USER node, recursos históricos y healthcheck.
- .dockerignore limita el contexto a package.json, server, public, prolog y
  plugins, con exclusiones posteriores de secretos, repositorios, dependencias,
  cachés y evidencia. No copia el directorio test/, .git o .deps a GameConsole;
  los tests Prolog que pertenecen al paquete sí acompañan sus recursos privados.
- Compose solo añade las tres variables SDK al servicio gameconsole, conservando
  GAMESTATS_URL interno, los tres servicios, healthchecks heredados de imágenes,
  loopback, dependencia saludable, read_only, tmpfs y restricciones de capacidades.
- `scripts/check.mjs` descubre ESM/JS en server/public/plugins/scripts/test y
  ejecuta únicamente node --check por archivo, sin importar módulos. Funciona
  con rutas Windows/Linux y sin expansión de glob del shell.
- `scripts/sdk-compose-integration.mjs` usa exclusivamente HTTP sobre servicios
  ya desplegados. No crea un servidor propio ni llama a Docker/Prolog directamente.
- CI conserva pruebas históricas Node, incorpora todas las suites SDK y verifica
  el Prolog empaquetado. La integración pesada se limita a main/manual.
- prepare.mjs, deploy.mjs, integración histórica y recuperación no se reescriben.
  Los juegos, Bridge, consola, Manager, Outbox y GameStats no cambian.

La prueba de empaquetado copia los mismos cinco inputs de Dockerfile a un
directorio temporal y carga/prepara los tres paquetes con el bootstrap auténtico.
Comprueba HTML/perfiles y resuelve el Prolog privado relativo al adaptador; no
ejecuta SWI, acciones, sockets o envío de eventos. Esto verifica contenido y rutas,
**no construye ni ejecuta una imagen**. Las comprobaciones Compose/CI locales son
estáticas; la validación semántica oficial de Compose queda para Docker/CI.

Resultados locales: 12 pruebas nuevas aprobadas (empaquetado/CI estáticos y
ejecutor con transporte inyectado), incluidas espera 202, fallo 503, dependencia
parcial, replay duplicado, basis incorrecta y timeout global. La regresión
focalizada de 27 archivos SDK/HTTP/Outbox aprobó **260 pruebas, 0 fallos, 0 skips**.
`node scripts/check.mjs` aprobó sintaxis de **101 archivos**; no ejecuta sus
entrypoints. No se utilizó npm test aquí porque incluye Prolog real. Los reportes
unitarios temporales fueron identificados como simulados y no se guardaron como
evidence/sdk-integration.json auténtico.

## Fuentes Go/Scala inspeccionadas

`.deps/gamestats` estaba limpio en el SHA exacto del lock:
`4adee854ea3b35148b1eadd0549d4d8e647b345c`. No se ejecutó prepare/fetch, porque ya
se podían inspeccionar las fuentes y esta fase prohíbe descargas/builds automáticos.

Compose usa esa raíz como contexto de ambos Dockerfiles:

| Imagen | Fuente fijada y empaquetado |
| --- | --- |
| Go | go-ingestion/Dockerfile: compilación Go 1.26.5 con CGO deshabilitado y runtime Alpine, usuario 10001 y healthcheck /health. |
| Scala | scala-analysis/Dockerfile: Java 21, launcher sbt con checksum y dockerStage, runtime JRE y perfiles desde docs/examples/profiles a /app/profiles. |

No se copiarán calculadoras analíticas a Node. Los perfiles inspeccionados
corresponden a tic-tac-toe, snake y racing y coinciden con las copias versionadas
de los paquetes. Copiar el perfil al paquete no implica registro dinámico en Scala:
la imagen Scala ya lo copia desde GameStats fijado.

En GameConsole el adaptador resuelve `../prolog/gato.pl` desde import.meta.url,
es decir `/app/plugins/tic-tac-toe/prolog/gato.pl`. No usa el programa histórico.

## Variables y operación

```yaml
GAMECONSOLE_SDK_ENABLED: "1"
GAMECONSOLE_PLUGINS_DIR: /app/plugins
GAMECONSOLE_TRUSTED_IDS: tic-tac-toe,snake,racing
GAMESTATS_URL: http://go-ingestion:8080
```

Arranque: `node scripts/deploy.mjs`; apagado: `node scripts/deploy.mjs --stop`.
El mecanismo ASCII de Windows y el proyecto gameconsole se conservan. Los puertos
publicados siguen PORT=3000 y GAMESTATS_PORT=8080. La URL principal debe presentar
la consola SDK, y `/api/sdk/catalog` exactamente tres IDs; health 200 no basta.

No se fija un origen público localhost. Para HTTP se deriva del Host validado.
GAMECONSOLE_PUBLIC_ORIGIN solo corresponde a un proxy HTTPS real, configurado en
el entorno del servicio mediante override explícito. No se relajan CSP, sandbox,
CORS ni la validación de cabeceras.

## Prueba real finita y evidencia

```powershell
node scripts/deploy.mjs
# Solo si se cambiaron puertos o direcciones; usar valores accesibles desde el host:
$env:CONSOLE_URL='http://127.0.0.1:3000'
$env:GAMESTATS_URL='http://127.0.0.1:8080'
npm run test:integration:sdk
node scripts/deploy.mjs --stop
```

Ejecutar sin jugadores/productores simultáneos. Se rechazan partidas SDK abiertas
o prefijos locales pendientes antes de empezar. Partidas anteriores finalizadas
pueden permanecer: se comprueban diferencias respecto del dashboard inicial.

Etapas:

1. Salud Node/Go, root SDK, dashboard previo verdadero y catálogo exacto.
2. Tres creaciones concurrentes mediante POST SDK, tres UUID y listado running.
3. PLACE_MARK con expectedVersion inicial; exigir dos confirmaciones, X, una O,
   decisión minimax y awaitingAI=false. TICK y STEP reales con aislamiento de datos
   y versiones. No hay simulación del reloj, reglas o decisiones en este script.
4. Esperar pending=0 por partida. Consultar Go /matches/gameId/matchId y comparar
   identidad, estado, eventCount, IDs únicos y cantidad entregada por Outbox.
5. Consultar resultados SDK; un 202 espera con intervalos de 500 ms. Comprobar
   source/profileVersion, basis.eventCount/lastEventId y métricas de perfiles reales.
6. Replay exacto de PLACE_MARK con requestId/expectedVersion originales; comparar
   resultado y eventIds Go antes/después, sin otro movimiento.
7. Dashboard provisional: +3 iniciadas/activas, mismos IDs y eventos entregados.
8. Cierres administrativos concurrentes; esperar todos, prefijos previos intactos
   más un cierre por partida. Resultados closed y dashboard +3 finalizadas.

Métricas mínimas comprobadas: moves.match y board.result (Gato); apples.match,
points.player y patrón apples.burst (Snake); laps.match y lap_time.avg.player
(Circuito); duration.match en los tres. Con una STEP no se inventa una vuelta:
avg permanece unavailable/no_samples. Abandonar Gato sin victoria mantiene
board.result unavailable/insufficient_evidence; no se exige un ganador falso.
Una manzana accidental en el primer TICK es válida: se usan conteos reales, sin
suponer que Snake siempre produce cero eventos de dominio.

Límite global: 120 s por defecto, máximo 180 s mediante
SDK_INTEGRATION_TIMEOUT_MS. Cada HTTP tiene hasta 10 s y respeta también el límite
global. No hay carreras/tableros completos ni polling intensivo. Los cierres y
creaciones esperan allSettled para no perder respuestas de partidas hermanas.

Siempre se intenta escribir `evidence/sdk-integration.json`. El reporte contiene
fecha UTC, etapa/código de fallo, intentos de creación, IDs, recibos de acciones
(incluidos committed y snapshots parciales), estados locales, ingestión Go,
resultados Scala y dashboards. No guarda URLs con credenciales, cuerpos de error,
trazas o rutas locales. El SHA esperado se registra como requisito de build;
HTTP no expone ni certifica por sí mismo el Git SHA del binario remoto.

Ante fallo se intenta cerrar solo los IDs obtenidos, dentro del mismo deadline.
Ese cleanup no certifica entrega remota. Una creación de resultado desconocido
puede dejar un ID no recibido: revisar listado y logs, sin reintentar create a
ciegas ni afirmar rollback. El reporte permanece failed aunque el cleanup funcione.

Las pruebas unitarias inyectan transporte y etiquetan sus reportes
injected-test-transport en archivos temporales, luego eliminados. La CLI usa
configured-http-services, no importa analysis-double y rechaza su source SIMULADO.
La procedencia se comprueba contra el contrato real; no es autenticación
criptográfica de un servidor arbitrario. La ejecución auténtica debe usar el
Compose y fuentes que el equipo/CI acaban de revisar/construir.

## CI/CD

| Job | Cuándo | Qué hace |
| --- | --- | --- |
| verify | PR, push main y manual | Node 22, SWI, sintaxis, npm test (histórico+SDK), tests Prolog empaquetados. |
| integrated | Solo push main o manual con integration=true, después de verify | Prepare fijado, verificación SHA, compose config --quiet, build, up --wait, una integración SDK, evidencia y limpieza. |

El proyecto CI usa gameconsole-ci-run_id-run_attempt. Guarda el JSON y hasta 100
líneas por servicio de logs en fallo; upload y down usan always. La integración
histórica de seis partidas y recovery siguen disponibles manualmente, pero no
duplican esta ejecución pesada. No se publican imágenes ni se despliega un sitio
remoto ni requiere secretos de despliegue. Esta etapa no registró una ejecución de Actions.

## Verificaciones pendientes al cierre de la fase 3F

- Ejecutar una construcción y arranque controlados con Docker/Compose.
- Confirmar Prolog dentro de la imagen, root SDK y catálogo real.
- Ejecutar test:integration:sdk contra Go/Scala verdaderos y conservar el JSON.
- Jugar manualmente y revisar navegador, accesibilidad y estadísticas.
- Revisar/crear el commit por el equipo y ejecutar workflow_dispatch sobre ese SHA.
  No hay una nueva CI verde verificable mientras estos cambios no estén publicados.
- Grabar/publicar video y entregar en Tec Digital; el guion no es el video.

Las imágenes Go/Scala siguen dependiendo de descargas de bases/launcher durante
build. El lock fija sus fuentes, pero no garantiza disponibilidad de red ni una
construcción byte a byte de Node/paquetes apt. No se han introducido persistencia,
autenticación, nuevos servicios ni cambios de política de instancias.
