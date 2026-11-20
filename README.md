# GameConsole SDK v1

Proyecto 2 · Lenguajes de Programación, TEC · Francisco Castillo y Justin.
Tres paquetes autónomos: Gato (SWI-Prolog), Snake y Circuito. La consola descubre
plugins confiables, administra partidas e incrusta sus interfaces mediante Bridge v1.
Go recibe eventos; Scala calcula estadísticas. El navegador no calcula métricas.

**3F está preparada para validación real.** Se han realizado inspección y pruebas
ligeras; no se certifican todavía las nuevas imágenes, Compose o GitHub Actions.
Consultar [estado y detalles de 3F](docs/sdk-v1/phase-3f-deployment.md).

La [Fase 3G](docs/sdk-v1/phase-3g-multiinstance-experience.md) habilita varias
partidas independientes de cada juego y reorganiza la consola en biblioteca,
área de juego enfocada/cuadrícula e historial. Verificada con pruebas ligeras;
su revisión visual y las estadísticas contra servicios reales quedan a cargo del equipo.

## Requisitos y arranque reproducible

Git, Node.js 22 y Docker Engine/Desktop con contenedores Linux y Compose v2
compatible con `up --wait`. Se requiere acceso a Internet para obtener fuentes,
imágenes y dependencias de compilación. No es necesario instalar Go, Scala o
SWI-Prolog en el anfitrión al utilizar Docker.

```powershell
git clone https://github.com/JusMH/gameconsole.git
cd gameconsole
node scripts/deploy.mjs
```

Abrir **http://127.0.0.1:3000/**. El SDK es la experiencia principal de Compose;
también está en `/sdk/console.html`. El catálogo debe mostrar exactamente Gato,
Snake y Circuito; un healthcheck 200 por sí solo no demuestra esa configuración.

El preparador obtiene GameStats de `gamestats.lock.json`, fijado en
`4adee854ea3b35148b1eadd0549d4d8e647b345c`. Si hay modificaciones en `.deps`
se detiene sin sobrescribirlas. No se sustituye una dependencia inaccesible por
datos simulados. En rutas Windows con caracteres no ASCII, deploy usa una copia
de construcción bajo el directorio temporal. No modificar GameStats allí.

```powershell
node scripts/deploy.mjs --stop
```

Este apagado actúa sobre el proyecto Compose `gameconsole`. No ejecuta prune ni
borra volúmenes de otros proyectos. Reiniciar los procesos pierde sus datos en memoria.

## Servicios y configuración

| Servicio | Contenido | Acceso predeterminado |
| --- | --- | --- |
| gameconsole | Node.js 22, SDK, tres paquetes completos y SWI-Prolog | 127.0.0.1:3000 |
| go-ingestion | GameStats Go, construido desde el SHA fijado | 127.0.0.1:8080 |
| scala-analysis | GameStats Scala/Java 21 con perfiles del mismo SHA | DNS interno, puerto 9000 |

Prolog es un proceso dentro de gameconsole, no un cuarto servicio. Compose conserva
healthchecks, dependencias saludables, usuarios sin privilegios, filesystem de
solo lectura, tmpfs y capacidades restringidas.

Variables del servicio gameconsole:

```yaml
GAMECONSOLE_SDK_ENABLED: "1"
GAMECONSOLE_PLUGINS_DIR: /app/plugins
GAMECONSOLE_TRUSTED_IDS: tic-tac-toe,snake,racing
GAMESTATS_URL: http://go-ingestion:8080
```

`PORT` y `GAMESTATS_PORT` cambian los puertos loopback publicados:
en PowerShell, por ejemplo, `$env:PORT='3001'` antes de deploy. Las URLs de las
pruebas deben ser accesibles desde el anfitrión; CONSOLE_URL y GAMESTATS_URL
permiten indicarlas explícitamente. El valor Go interno de Compose no se cambia
por una dirección localhost del anfitrión.

Para HTTP local no se fija GAMECONSOLE_PUBLIC_ORIGIN: el host validado conserva
el puerto real. Solo ante un reverse proxy HTTPS, configurar esa variable en el
entorno del servicio (por ejemplo, mediante un override local) con el origen
HTTPS canónico, sin ruta, query ni credenciales. No se confía en Forwarded del cliente.

## Jugar, abrir partidas y consultar estadísticas

1. Elegir un juego en la biblioteca dinámica y configurar sus opciones.
   Gato: easy/medium/hard (hard predeterminado); Snake: 12/20/28; Circuito: tres
   vueltas fijas. La validación definitiva es del SDK.
2. Crear la partida. Gato utiliza clic o Tab/Enter para colocar X; Prolog decide O.
   Snake usa Jugar y flechas/WASD o botones. Circuito usa Jugar,
   mantiene acelerar/frenar y cambia de carril con flechas/A-D o botones.
3. Crear más partidas, incluso del mismo juego: los tres manifiestos permiten
   **múltiples instancias independientes**. Cuatro Circuitos tienen cuatro UUID,
   tableros/estados y versiones propios; crear otra partida no sustituye la anterior.
4. En Partidas, elegir una en la lista compacta o activar Cuadrícula para ver varias.
   Seleccionar o cambiar de sección conserva los iframe. Diagnóstico permite ocultar
   o restablecer una vista; restablecer crea un iframe nuevo para la misma partida.
   Cada tarjeta de cuadrícula muestra sus propias estadísticas de GameStats. Ctrl +
   Alt + J / K recorre y enfoca juegos activos, también desde dentro de un iframe.
   Los atajos no transfieren el control entre pestañas. Más métricas y patrones
   conserva el acceso al resultado analítico completo.
5. Nueva pestaña abre `/?match=<id>`: comparte la misma partida y UUID;
   **no crea una instancia adicional**. Puede haber conflictos de versión entre
   clientes. Recargar recupera las partidas del proceso, sin persistencia durable.
6. Resultados en vivo consulta la partida seleccionada aproximadamente cada 3 s.
   Estadísticas generales consulta el dashboard de GameStats cada 5 s, incluidos
   conteos por juego y muestras inválidas. Null/no disponible no equivale a cero.

Snake/Circuito se inician una vez con Jugar; el botón permite Pausa/Continuar.
Cambiar el foco libera teclas, sin exigir otra activación. En Ajustes, Pausar al
ocultar y Reanudar al regresar están habilitados por defecto: volver resincroniza
antes de avanzar. La pausa manual se conserva. Son preferencias de actividad local,
no pause/resume oficial del SDK ni un cambio de las duraciones de GameStats.
Con Web Locks, otra pestaña de la misma partida entra como observadora y puede
Tomar control de manera ordenada. Sin soporte se advierte que no hay exclusividad
garantizada. No coordina navegadores o equipos diferentes.
Consultar [comportamiento y límites de 3H](docs/sdk-v1/phase-3h-game-experience.md).
La [Fase 3I.1](docs/sdk-v1/phase-3i1-multigame-ux.md) mantiene Pausa estable durante
ticks normales, permite pausar una acción pendiente y añade estadísticas por tarjeta
con consultas compartidas y acotadas. La primera sincronización y los errores se
siguen mostrando; no se ocultan operaciones inciertas ni se alteran reglas.
Finalizar es administrativo; no fabrica victoria ni carrera completada.
Al confirmarse finished, la vista muestra brevemente el final y libera su canal
tras 1,8 s. La partida queda en el historial plegable con sus resultados; consultarla
no monta otro iframe ni emite otro cierre. Al recargar se prefieren partidas activas.
Los nombres numerados y UUID abreviados son presentación; el identificador completo
y la información de entrega están en Diagnóstico. Una partida finalizada sigue
ocupando memoria del SDK hasta reiniciar el proceso.

## Confirmado, entregado y analizado

- **Confirmado localmente:** SDK aceptó estado/eventos en memoria y avanzó versión.
- **Entregado:** Outbox confirmó el prefijo en Go; no significa que Scala lo analizó.
- **Analizado:** una consulta de resultados/dashboard devolvió datos de Scala,
  con status y basis correspondientes. El cierre puede dejar métricas unavailable
  legítimas: abandonar Gato no inventa ganador; un promedio sin vueltas no es cero.

Si Prolog falla después de confirmar X, la X permanece y awaitingAI permite
Reintentar IA. Un resultado desconocido del Bridge no se reintenta automáticamente
con otra identidad. Si GameStats falla, los juegos pueden seguir confirmando
localmente y mostrar entregas pendientes; no se sustituyen estadísticas por
cálculos JavaScript. Consultar logs y recuperar el servicio, no reiniciar Go
durante partidas esperando conservar sus inicios.

## Verificación y evidencia

```powershell
npm run check
node --test test/sdk-deployment.test.mjs test/sdk-compose-integration.test.mjs
# Solo con los tres servicios reales desplegados y sin jugadores simultáneos:
npm run test:integration:sdk
```

La prueba SDK tiene límite global predeterminado de 120 s (máximo 180 s mediante
SDK_INTEGRATION_TIMEOUT_MS), polling moderado y una sola acción por juego. Comprueba
catálogo/root, tres UUID concurrentes, Prolog real, aislamiento, replay, entrega a
Go, métricas provisionales/finales de perfiles reales y dashboard +3. Finaliza sus
propias partidas conocidas; no completa carreras ni toca sesiones ajenas.
Exige un entorno sin partidas SDK abiertas y sin productores concurrentes.

Evidencia: `evidence/sdk-integration.json`, incluso ante fallo. Incluye etapas,
IDs, recibos locales, estados Go, basis/procedencia Scala y resultados. Un POST de
resultado desconocido puede dejar una partida cuyo ID no se obtuvo: inspeccionar
el listado y cerrar manualmente; no se afirma rollback. Los dobles de pruebas
llevan transport=injected-test-transport y **no son evidencia real**.

`npm test` incluye las pruebas históricas que requieren SWI-Prolog. La integración
histórica `npm run test:integration` y recuperación `node scripts/recovery.mjs`
se conservan como comprobaciones manuales separadas; no ejecutarlas indiscriminadamente
ni duplicarlas con la integración SDK en la CI.

Para inspección, desde la raíz:

```powershell
docker compose -p gameconsole ps
docker compose -p gameconsole logs --no-color --tail=100 gameconsole go-ingestion scala-analysis
```

## CI/CD y entrega

GitHub Actions ejecuta Node 22, sintaxis, pruebas Node y Prolog en PR/main/manual.
Las imágenes y **una** integración SDK real se ejecutan solo en push a main o
workflow_dispatch con integration habilitado. En Actions → GameConsole CI →
Run workflow, elegir la rama revisada y habilitar integration. No necesita
secretos de despliegue ni publica una web remota. La preparación descarga la
dependencia fijada; Compose valida, construye, espera salud, ejecuta y guarda el
artefacto sdk-integration. Siempre intenta detener su proyecto aislado.

No afirmar CI en verde hasta tener una ejecución del commit entregado. Guardar
esa URL, artefacto, SHA, captura de servicios saludables y evidencia real.
Deployment significa **Docker Compose local**, no alojamiento en Internet.

## Arquitectura, límites y documentación

```text
Consola SDK → iframe sandbox + Bridge → API genérica → Manager
                                                    ↓
Plugin (Rules/Session; Gato → Prolog privado) → EventSink/Outbox → Go → Scala
```

Registro/fábrica, Facade/Adapter, Observer y colas por instancia separan dominio,
presentación, lifecycle y analítica. Los paquetes residen en plugins/, el runtime
en server/sdk/ y la consola en public/sdk/. El frontend/rutas históricos siguen
disponibles: fuera de Compose, SDK deshabilitado conserva el root anterior.
Para ese modo dejar sin definir el directorio y trustedIds además de deshabilitar
SDK; la configuración segura rechaza SDK=0 con una lista/directorio todavía activos.

Memoria no durable; máximo actual de 500 partidas por proceso y 32 canales por
HostBridge. No hay cuentas, autorización de titulares ni exclusividad entre pestañas.
Origin y sandbox web no aíslan código Node no confiable: solo se cargan IDs
instalados y autorizados. No se incorporan nuevos juegos, perfiles ni dependencias.

- [Documentación SDK](docs/sdk-v1/README.md)
- [3F: despliegue e integración](docs/sdk-v1/phase-3f-deployment.md)
- [Matriz de entrega](docs/entrega.md)
- [Guion de video, 12 minutos](docs/video.md)
- GameConsole (origin verificado): https://github.com/JusMH/gameconsole
- GameStats: https://github.com/JusMH/gamestats

Pendientes humanos: validación real, accesibilidad/jugabilidad final, ejecución
de Actions, video público y entrega en Tec Digital antes del **20/11/2026, 22:00
de Costa Rica**. No se encontró el enunciado PDF/DOCX en los repositorios locales;
confirmar requisitos adicionales con el docente, sin inventar modalidades de juego.
