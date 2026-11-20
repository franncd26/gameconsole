# Referencia técnica del SDK v1

La documentación principal de entrega es el [README](../../README.md),
[arquitectura](../arquitectura.md), [integración](../integracion.md) y
[estado de verificación](../entrega.md). Esta carpeta conserva contratos y la
evolución técnica; los informes de fase no sustituyen las instrucciones actuales.

## Contratos y referencias vigentes

| Tema | Referencia |
| --- | --- |
| game.json, versiones, opciones, capacidades y rutas | [Manifiesto normativo](manifest.md) |
| Loader, Factory y preparación de sesiones | [Interfaces 2A](phase-2a.md) y código server/sdk/ |
| Activación/cierre y aceptación local | [2B.1](phase-2b1.md) y [EventSink/Outbox](phase-3a.md) |
| Celda de estado y confirmación de transiciones | [2B.2A](phase-2b2a.md) |
| dispatch, expectedVersion, requestId e idempotencia | [2B.2B](phase-2b2b.md) |
| Bootstrap y rutas HTTP | [3C](phase-3c.md), actualizado por [integración](../integracion.md) |
| Assets web, CSP, sandbox y Bridge v1 | [3E.1](phase-3e1-web-bridge.md), [PRESENTATION](phase-3h-game-experience.md) y [navegación](phase-3i1-multigame-ux.md) |
| Importación experimental, persistencia y perfiles Scala | [3I.2](phase-3i2-plugin-importer.md) |

Los ejemplos de una fase describen su versión de la API. El código actual y los
contratos posteriores prevalecen sobre limitaciones temporales: los tres plugins
ya están migrados, tienen UI jugable y permiten múltiples instancias. La configuración
académica habilita SDK y mantiene exactamente tres juegos; el importador es optativo.

## Registro y confianza

```js
import { validateManifest, loadManifest } from '../../server/sdk/manifest.mjs';
import { GameRegistry, discoverPlugins } from '../../server/sdk/registry.mjs';
const { registry, errors } = await discoverPlugins(directorioDePlugins);
const metadata = registry.get('sdk-example');
const catalog = registry.publicCatalog();
```

Descubrimiento inspecciona subdirectorios inmediatos y ordena candidatos de forma
determinista; no importa sus módulos. La raíz ausente produce un registro vacío.
Cada paquete inválido se aísla y devuelve un rechazo saneado. El primer ID válido
registrado se conserva y los siguientes producen DUPLICATE_ID, sin reemplazo.

`register`, `get` y `list` entregan copias de `{manifest,directory,paths}` para uso
interno. La opción interna `expected` de register comprueba los metadatos antes
de publicar una candidatura del importador. No hay API pública de sustitución o borrado.

`publicCatalog()` expone solo id, name, version, description, category, capabilities,
players y options. Excluye directorios, módulos y rutas físicas; los textos se
representan mediante APIs seguras del DOM.

El bootstrap exige IDs confiables explícitos, bloquea errores de discovery y
faltantes, y no autoriza automáticamente todos los paquetes encontrados. Puede
haber paquetes válidos no autorizados que no se exponen. La configuración Compose
académica establece tic-tac-toe, snake y racing; la prueba integrada comprueba ese
catálogo exacto. El experimento añade autorizaciones mediante su instalador, sin
recrear Manager ni cambiar la autoridad del SDK.

## Evolución histórica

Los documentos siguientes conservan decisiones, pruebas y alcances de cada etapa.
Las afirmaciones sobre funciones futuras o verificaciones pendientes corresponden
a la fecha de esa etapa; el estado actual se registra en [entrega](../entrega.md).

- [Baseline 0/1](baseline.md) y [diseño original de runtime](runtime-design.md).
- [2A: preparación](phase-2a.md), [2B.1: lifecycle](phase-2b1.md),
  [2B.2A: transiciones](phase-2b2a.md) y [2B.2B: acciones](phase-2b2b.md).
- [3A: transporte](phase-3a.md) y [3C: bootstrap/API](phase-3c.md).
- [3D.1: Gato](phase-3d1-gato.md) y [3D.2: Snake/Circuito](phase-3d2-snake-racing.md).
- [3E.1: Bridge](phase-3e1-web-bridge.md), [3E.2: interfaces](phase-3e2-playable-web-games.md)
  y [3E.3: consola/estadísticas](phase-3e3-console-stats.md).
- [3F: preparación de despliegue](phase-3f-deployment.md),
  [3G: multiinstancia](phase-3g-multiinstance-experience.md),
  [3H: actividad local](phase-3h-game-experience.md) y [3I.1: UX multijuego](phase-3i1-multigame-ux.md).

Las comprobaciones actuales se ejecutan con `npm run check` y `npm test` desde la
raíz. La suite completa necesita SWI-Prolog y Python 3. Los scripts de humo real
requieren sus servicios/configuración; las pruebas con dobles no certifican Go/Scala.
