# Manifiesto game.json — contrato normativo 1

Un paquete futuro agrupa `game.json`, servidor ESM, web ESM y perfil analítico
opcional. No se deduce identidad del nombre de la carpeta. El ID es estable
entre versiones y se utiliza como `gameId`; cambiarlo identifica otro juego.
La versión de juego cambia sin alterar su ID.

## Estructura

El [fixture completo](../../test/fixtures/sdk-v1/example/game.json) es un ejemplo
válido de metadatos. Sus módulos arrojan errores deliberadamente para detectar
una importación accidental: no implementan sesiones ni UI.

Todos los campos de esta tabla son obligatorios excepto `analytics`.
No se admiten claves desconocidas en ningún objeto normativo, ni extensiones
arbitrarias. Ausencia y `null` no son equivalentes.

| Campo | Regla y significado |
| --- | --- |
| `manifestVersion` | Número entero exacto `1`. Versión del formato del manifiesto. |
| `sdkVersion` | String exacto `"1.0"`. Compatibilidad con interfaces y semántica del SDK. No se acepta automáticamente `1.1`, `^1.0` ni rangos. |
| `id` | 1–64 caracteres, regex `[a-z0-9]+(?:-[a-z0-9]+)*`. Identidad única dentro del registro. |
| `name` | Texto de 1–80 caracteres para presentación. |
| `version` | 1–32 caracteres, versión estable `MAJOR.MINOR.PATCH`, enteros sin ceros iniciales salvo cero. No prerelease ni build metadata en v1. |
| `description` | Texto de 1–1000 caracteres. |
| `category` | Slug de 1–64 caracteres con la misma regex de `id`; clasificación abierta, sin condiciones por juego. |
| `entrypoints` | Objeto con exactamente `server` y `web`, rutas a archivos `.mjs` existentes. |
| `capabilities` | Exactamente cuatro booleanos explícitos: `pause`, `resume`, `multipleInstances`, `ai`. |
| `players` | Exactamente `{min,max}`: enteros, `1 <= min <= max <= 16`. Incluye participantes humanos y de IA; no promete red o PvP. |
| `analytics` | Opcional; si aparece, exactamente `{profile}` con ruta a archivo `.json` existente. |
| `options` | Arreglo obligatorio de 0–32 opciones declarativas, IDs únicos dentro del paquete. |

Los límites de texto cuentan unidades UTF-16 (`string.length`). Se rechazan
controles U+0000–U+001F y U+007F, texto vacío y espacios exteriores. Los campos
son texto plano, no HTML, funciones, comandos ni expresiones ejecutables.

`pause` y `resume` deben coincidir; no se acepta una pausa sin reanudación.
`multipleInstances: true` es una promesa futura de sesiones independientes, sin
estado mutable compartido de partida en el módulo. `false` permitirá como máximo
una sesión activa de ese juego en el host futuro. `ai` solo describe una capacidad;
no concede acceso al intérprete ni ejecuta Prolog. El registro no comprueba que
esas promesas coincidan con el código: esa verificación pertenece al runtime futuro.

## Opciones declarativas

Cada opción tiene `id` (misma regex y límite que el ID del juego), `label` (1–80),
`type`, `default` obligatorio y `description` opcional (1–500). Los valores extra
permitidos y obligatorios dependen exclusivamente del tipo:

| `type` | Campos adicionales obligatorios | Validación del default |
| --- | --- | --- |
| `boolean` | Ninguno | Booleano estricto. |
| `integer` | `min`, `max`: enteros entre -1 000 000 y 1 000 000, `min <= max` | Entero dentro del intervalo inclusivo. |
| `string` | `minLength`, `maxLength`: enteros, `1 <= minLength <= maxLength <= 256` | Texto con las reglas generales y longitud dentro del intervalo. |
| `enum` | `values`: 1–32 strings distintos de 1–80 caracteres | Uno de los strings declarados, comparación exacta. |

No hay referencias, callbacks, validadores ejecutables, objetos anidados,
expresiones regulares configurables, URLs ni secretos. Los campos propios de un
tipo se rechazan en los otros tipos. Los defaults permiten un formulario futuro
genérico. Esta fase valida **la declaración y los defaults**, no implementa el
formulario ni la validación de opciones recibidas al crear partidas. En el diseño
futuro el host aplicará defaults a campos omitidos, rechazará claves desconocidas
y valores fuera de límites sin coerción, y entregará una copia al plugin.

## Archivos y seguridad de rutas

El manifiesto es JSON UTF-8 de hasta 64 KiB; se lee con un límite efectivo antes
de parsearlo. Se usa la semántica de `JSON.parse`: claves JSON repetidas conservan
su última aparición; no se permiten comentarios ni comas finales. La función
`validateManifest` recibe un objeto ya parseado y valida estructura; `loadManifest`
es la entrada que valida además JSON, tamaño y sistema de archivos.

Las rutas tienen 1–240 caracteres, son relativas al paquete y usan `/`. Cada
segmento debe comenzar con ASCII alfanumérico, `_` o `-`; los caracteres restantes
solo pueden ser ASCII alfanumérico, `_`, `-` o `.`. Se rechazan segmentos vacíos,
`.`/`..`, puntos finales, dispositivos reservados de Windows (`CON`, `NUL`, etc.),
backslashes, rutas de disco o UNC, esquemas de URL y escapes `%`. Las extensiones
son sensibles a mayúsculas: `.mjs` y `.json` respectivamente. No hay normalización
que convierta una ruta inválida en válida.

Se calcula la raíz real del paquete y la ruta real de `game.json` y de cada
archivo declarado. Cada archivo debe ser regular y quedar estrictamente dentro
de la raíz real del paquete, comparando límites de segmentos mediante
`path.relative`. Un enlace interno solo se acepta si su destino real permanece
dentro del paquete; cualquier escape mediante symlink/junction se rechaza.
El discovery rechaza además candidatos que sean enlaces a directorios.

Los archivos web y servidor solo se comprueban por existencia, ubicación y tipo;
su sintaxis, exports y dependencias no se ejecutan ni se inspeccionan. El perfil
analítico solo se localiza: no se valida su contenido ni se registra en Go/Scala.
`analytics.profile` no implica soporte automático de nuevos cálculos en Scala.

El directorio configurado y los paquetes deben permanecer estables durante la
inspección. La validación de rutas no constituye sandbox contra modificaciones
concurrentes del sistema de archivos (TOCTOU), ni un mecanismo de confianza para
ejecutar plugins de terceros. Antes de un futuro cargador habrá que decidir esa
política. Ninguna de estas comprobaciones autoriza ejecutar el plugin ahora.
