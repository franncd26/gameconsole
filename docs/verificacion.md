# Comprobaciones técnicas de GameConsole

La validación del proyecto combina pruebas automatizadas, una integración real y pruebas manuales de la interfaz.

## Automatización

La [ejecución aprobada de GitHub Actions](https://github.com/JusMH/gameconsole/actions/runs/44814482222) incluye:

- **342 pruebas Node aprobadas**, sin errores ni cancelaciones.
- Pruebas de SWI-Prolog con las estrategias del juego Gato.
- Construcción de los servicios Node, Go y Scala mediante Docker.
- Verificación de creación de partidas, eventos entregados, métricas y dashboard mediante el ejecutor integrado.
- Publicación del [artefacto de integración](https://github.com/JusMH/gameconsole/actions/runs/44814482222/artifacts/14669531219).

## Prueba local

Con Docker instalado:

```powershell
node scripts/deploy.mjs
docker compose -p gameconsole ps
```

Para ejecutar pruebas desde el repositorio:

```powershell
npm run check
npm test
```

Con el sistema desplegado, sin otras partidas activas:

```powershell
npm run test:integration:sdk
```

La última orden genera `evidence/sdk-integration.json` y comprueba el recorrido entre GameConsole, Prolog, Go y Scala. Para detener el entorno: `node scripts/deploy.mjs --stop`.

## Comprobación visual

La demostración debe verificar los controles de Gato, Snake y Circuito; la ejecución de varias partidas simultáneas; los datos por juego; las estadísticas generales de GameStats y el historial de partidas.

Las partidas y los eventos pendientes se conservan solo mientras permanecen activos los procesos correspondientes.
