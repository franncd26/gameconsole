# GameConsole SDK v1 — Fases 0–3F

Esta carpeta define el contrato para una evolución incremental. **Están
implementados manifiestos, registro y la infraestructura local de carga confiable,
preparación y administración de sesiones de Fase 2A, y activación/cierre con eventos
de ciclo de vida mediante EventSink inyectable de Fase 2B.1, y confirmación interna
de datos/eventos/versiones de Fase 2B.2A y fachada dispatch JSON con historial
acotado de Fase 2B.2B, y adaptador EventSink → EventOutbox con lotes de Fase 3A**.
La [Fase 3C](phase-3c.md) añade bootstrap explícito de confianza y API optativa
`/api/sdk/`, compartiendo el Outbox histórico. El equipo reporta PASSED del humo
de transporte 3B y HTTP 3C contra Go/Scala. Las pruebas automatizadas usan fetcher simulado.
La [Fase 3D.1](phase-3d1-gato.md) migra el servidor de Gato a un paquete autónomo;
el equipo reporta PASSED de su humo con Prolog/Go/Scala reales.
La [Fase 3D.2](phase-3d2-snake-racing.md) añade Snake y Circuito autónomos y
concurrencia multijuego; su nuevo humo real queda preparado para ejecución manual.
La [Fase 3E.1](phase-3e1-web-bridge.md) añade recursos web confiables, iframe
sandbox y Bridge v1 con harness independiente y páginas de estado. Se comprobó
el handshake de los tres plugins en navegador real con Go simulado.
La [Fase 3E.2](phase-3e2-playable-web-games.md) añade las interfaces jugables
independientes de Gato, Snake y Circuito, con acciones exclusivamente por Bridge.
La [Fase 3E.3](phase-3e3-console-stats.md) compone la consola visual SDK, biblioteca
genérica, partidas concurrentes y consultas en vivo a GameStats. Con SDK habilitado
es la página principal; deshabilitado conserva el frontend histórico. No hay
autenticación nueva. Los fixtures no son un cuarto juego.
La [Fase 3F](phase-3f-deployment.md) prepara empaquetado Docker, activación SDK
en Compose, CI main/manual e integración auténtica contra servicios desplegados.
La nueva construcción y su ejecución real permanecen pendientes de validación.

- [Manifiesto normativo v1](manifest.md): campos, límites y reglas de archivos.
- [Contrato diseñado de runtime y patrones](runtime-design.md): trabajo futuro.
- [Fase 2A implementada](phase-2a.md): interfaces exactas, preparación y límites.
- [Fase 2B.1 implementada](phase-2b1.md): eventos v1, aceptación local, activación y cierre.
- [Fase 2B.2A implementada](phase-2b2a.md): celda optativa, confirmaciones, lotes y fallos parciales.
- [Fase 2B.2B implementada](phase-2b2b.md): dispatch JSON, expectedVersion, replay e historial FIFO.
- [Fase 3A implementada](phase-3a.md): OutboxEventSink, enqueueBatch, pruebas locales y humo manual pendiente.
- [Fase 3C implementada](phase-3c.md): bootstrap confiable, rutas HTTP, límites y humo HTTP manual.
- [Fase 3D.1 implementada](phase-3d1-gato.md): paquete autónomo Gato, reglas, IA Prolog y recuperación.
- [Fase 3D.2 implementada](phase-3d2-snake-racing.md): paquetes Snake/Circuito y concurrencia de los tres juegos.
- [Fase 3E.1 implementada](phase-3e1-web-bridge.md): assets confiables, CSP/sandbox, Bridge v1 y demo de conexión.
- [Fase 3E.2 implementada](phase-3e2-playable-web-games.md): interfaces, controles, cadencia, recuperación y verificación ligera.
- [Fase 3E.3 implementada](phase-3e3-console-stats.md): consola principal SDK, opciones dinámicas, pestañas y estadísticas Go/Scala.
- [Fase 3F preparada](phase-3f-deployment.md): despliegue local, CI y evidencia de integración real pendiente.
- [Baseline y revisión](baseline.md): protección de la base y verificación acotada.

## API implementada

Módulos ESM, solo bibliotecas estándar de Node.js 22:

```js
import { validateManifest, loadManifest } from '../../server/sdk/manifest.mjs';
import { GameRegistry, discoverPlugins } from '../../server/sdk/registry.mjs';

// validateManifest(objetoJSON) valida estructura y devuelve una copia.
// loadManifest(directorioPaquete) además comprueba archivos y rutas reales.
// Ambos rechazan con ManifestError: {code, field, message}.
const { registry, errors } = await discoverPlugins(directorioDePlugins);
const internos = registry.list();
const paquete = registry.get('sdk-example'); // undefined si no existe
const publico = registry.publicCatalog();
```

El fragmento ilustra APIs internas; el bootstrap 3C las compone antes del servidor.
`discoverPlugins()` usa por defecto `plugins/` en la raíz de este repositorio,
independientemente del directorio de trabajo. No se crea esa carpeta ni se instala
ningún paquete productivo ahora. Las rutas configurables se reciben como strings;
una ruta relativa explícita se resuelve contra el directorio de trabajo de Node.

`GameRegistry.register(directorioPaquete)` es asíncrono y vuelve a validar el paquete.
Devuelve `{manifest, directory, paths}`; `paths` contiene las rutas reales absolutas
de `server`, `web` y, si existe, `profile`. `get` y `list` usan ese mismo formato;
son APIs internas, nunca respuestas HTTP. `register` devuelve también una copia.
Todas las lecturas devuelven copias profundas defensivas: modificarlas no modifica
el registro. No existe API de sustitución, borrado ni carga de módulos.

`publicCatalog()` usa una lista explícita de campos: `id`, `name`, `version`,
`description`, `category`, `capabilities`, `players`, `options`. Excluye entrypoints,
perfil analítico, directorios y rutas resueltas. Los textos son metadatos no confiables:
la futura UI deberá representarlos como texto, sin interpretarlos como HTML.
No se publicarán las APIs internas ni los diagnósticos como catálogo público.

## Descubrimiento y fallos

Solo se consideran subdirectorios inmediatos. Los archivos sueltos se ignoran;
los candidatos enlazados simbólicamente (incluidas junctions) se rechazan. Cada
subdirectorio debe tener `game.json`; uno sin él produce un rechazo. Los nombres
de carpetas se ordenan con comparación de unidades de código de JavaScript, sin
dependencia del locale. El primer **paquete válido** que registra un ID gana;
los siguientes reciben `DUPLICATE_ID`, sin sustitución silenciosa. Un paquete
inválido no reserva su ID. `list` y `publicCatalog` se ordenan por ID.

El resultado siempre contiene un registro y un arreglo de rechazos con
`{candidate, code, field, message}`. `candidate` es un nombre de carpeta sencillo
o una etiqueta ordinal si el nombre no es seguro; nunca una ruta absoluta.
La raíz ausente (`ENOENT`) devuelve catálogo vacío y ningún error. Otros fallos
al inspeccionar la raíz producen `DISCOVERY_IO` con `candidate: null`.
Cada paquete rechazado se aísla y se continúa con los restantes.

## Catálogo obligatorio y bootstrap

El resultado de discovery es un diagnóstico utilizable, **no una autorización de
arranque**. Se conserva la política de primer paquete válido para inspección y
pruebas. Que el registro contenga un ID no resuelve un conflicto si existe además
un rechazo `DUPLICATE_ID`. No se elegirá silenciosamente un ganador en producción.

Antes de publicar rutas o aceptar partidas SDK, el bootstrap 3C revisa errores e
IDs confiables requeridos. Para el futuro despliegue académico migrado se deberá:

1. Ejecutar discovery y revisar todos sus errores. Cualquier rechazo, incluidos
   duplicados y errores de lectura, bloqueará el arranque productivo con un
   diagnóstico explícito. Los paquetes siguen aislados durante la inspección.
2. Comparar los IDs válidos con un conjunto obligatorio configurado y aprobado
   para el despliegue. Para la entrega académica será exactamente
   `tic-tac-toe`, `snake`, `racing`: faltantes y extras bloquearán el arranque,
   incluso si la raíz ausente devolvió un registro vacío sin errores.
3. Habilitar la aplicación solo tras superar ambas comprobaciones; sin fallback
   silencioso a un catálogo parcial ni selección implícita de un duplicado.

El conjunto pertenece a la configuración del despliegue, no al SDK genérico ni a
condiciones por juego en el registro. Esto permite N paquetes en otros despliegues.
La comprobación será previa a la apertura del servidor, sin necesidad de cambiar
la API del discovery. **3C implementa esa comprobación de errores y faltantes para
la lista confiable explícita**, permite otros paquetes válidos no autorizados y
no impone todavía el catálogo académico migrado de tres juegos. La API es optativa
y de desarrollo; véase [configuración exacta](phase-3c.md). No deben desplegarse
los fixtures como plugins productivos. No se cambia
el comportamiento de directorio ausente ni la política actual de registro.

Códigos: `INVALID_JSON`, `INVALID_MANIFEST`, `INCOMPATIBLE_VERSION`, `UNSAFE_PATH`,
`INVALID_PATH`, `DUPLICATE_ID`, `DISCOVERY_IO`. Los mensajes incluyen un campo del
contrato y una explicación fija; no incluyen contenido del JSON, mensajes crudos
del sistema de archivos ni rutas locales. El descubrimiento no usa `import()`,
`require`, procesos externos, sockets ni ejecución de contenido del paquete.

## Verificación aislada

Desde la raíz de GameConsole:

```powershell
node --check server/sdk/manifest.mjs
node --check server/sdk/registry.mjs
node --check server/sdk/values.mjs
node --check server/sdk/options.mjs
node --check server/sdk/initialization.mjs
node --check server/sdk/loader.mjs
node --check server/sdk/session-factory.mjs
node --check server/sdk/instance-manager.mjs
node --check server/sdk/event-adapter.mjs
node --check server/sdk/actions.mjs
node --check test/sdk-v1.test.mjs
node --check test/sdk-runtime.test.mjs
node --check test/sdk-lifecycle.test.mjs
node --check test/sdk-transitions.test.mjs
node --check test/sdk-actions.test.mjs
node --check test/fixtures/sdk-v1/example/server.mjs
node --check test/fixtures/sdk-v1/example/web.mjs
node --check test/fixtures/sdk-runtime/counter/server.mjs
node --check test/fixtures/sdk-transitions/plugin.mjs
node --check test/fixtures/sdk-actions/plugin.mjs
node --test test/sdk-v1.test.mjs test/sdk-runtime.test.mjs test/sdk-lifecycle.test.mjs test/sdk-transitions.test.mjs test/sdk-actions.test.mjs
```

La verificación HTTP/Outbox completa de 3C está en [phase-3c.md](phase-3c.md).
No usar `npm test` para esta revisión acotada: incluye pruebas históricas con
servicios y Prolog. La nueva prueba solo usa memoria y archivos temporales; no
ejecuta los entrypoints trampa del fixture. El caso de symlink/junction informa
un skip explícito si el sistema no permite crear el enlace. `web.mjs` es ahora un
recurso de la página `web.html`; comprobar su sintaxis no ejecuta la página.
