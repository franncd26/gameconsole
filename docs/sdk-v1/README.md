# Referencia técnica del SDK v1

GameConsole ejecuta cada videojuego como un paquete independiente con manifiesto `game.json`, módulo de servidor, recursos web y perfil de análisis.

La documentación necesaria para instalar, usar y evaluar el proyecto está en:

- [README principal](../../README.md)
- [Arquitectura y decisiones técnicas](../arquitectura.md)
- [Integración con GameStats](../integracion.md)
- [Verificación del proyecto](../entrega.md)

## Contratos de consulta

| Tema | Documento |
| --- | --- |
| Estructura, opciones y capacidades de `game.json` | [Manifiesto del SDK](manifest.md) |
| Creación de sesiones y validación | [Preparación y fábrica](phase-2a.md) |
| Eventos de ciclo de vida | [Activación y cierre](phase-2b1.md) |
| Estado y transición confirmada | [Transiciones](phase-2b2a.md) |
| Acciones, versiones e idempotencia | [Acciones SDK](phase-2b2b.md) |
| Recepción y transporte de eventos | [EventOutbox](phase-3a.md) |
| API HTTP y Bridge web | [API](phase-3c.md) y [Bridge](phase-3e1-web-bridge.md) |
| Importación opcional de paquetes | [Importador experimental](phase-3i2-plugin-importer.md) |

Los demás documentos de esta carpeta amplían aspectos específicos del diseño y de sus pruebas. Para ejecutar el proyecto no es necesario recorrerlos; los contratos y comandos de uso vigentes se resumen en la documentación principal.

La configuración académica carga **Gato, Snake y Circuito** y mantiene deshabilitada la importación de nuevos paquetes.
