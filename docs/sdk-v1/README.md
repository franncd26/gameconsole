# GameConsole SDK v1 — Fases 0 y 1

Esta carpeta define el contrato para una evolución incremental. **Solo están
implementados la validación de manifiestos y el catálogo de paquetes**. El servidor
HTTP actual no importa estos módulos; su catálogo conserva Gato, Snake y Circuito.
No hay juegos migrados, runtime SDK, iframe, cargador web ni integración nueva con
Scala. El fixture de `test/fixtures/sdk-v1/example/` no es un cuarto juego.

- [Manifiesto normativo v1](manifest.md): campos, límites y reglas de archivos.
- [Contrato diseñado de runtime y patrones](runtime-design.md): trabajo futuro.
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

El fragmento ilustra llamadas; no se importa desde el servidor en esta fase.
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
node --check test/sdk-v1.test.mjs
node --check test/fixtures/sdk-v1/example/server.mjs
node --check test/fixtures/sdk-v1/example/web.mjs
node --test test/sdk-v1.test.mjs
```

No usar `npm test` para esta revisión acotada: incluye pruebas históricas con
servicios y Prolog. La nueva prueba solo usa memoria y archivos temporales; no
ejecuta los entrypoints trampa del fixture. El caso de symlink/junction informa
un skip explícito si el sistema no permite crear el enlace.
