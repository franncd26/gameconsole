# GameConsole

Proyecto 2 de Lenguajes de Programación, TEC · Francisco Castillo y Justin.

GameConsole ejecuta videojuegos web como plugins independientes. La consola permite
crear partidas concurrentes, jugar en una vista enfocada o en cuadrícula y consultar
estadísticas calculadas por GameStats mientras las partidas continúan.

La configuración académica incorpora exactamente tres videojuegos:

| Juego | Funcionamiento | Controles |
| --- | --- | --- |
| Gato | Tres dificultades; oponente con inteligencia artificial en SWI-Prolog | Clic o Tab/Enter; Reintentar IA si falla una decisión |
| Snake | Cuadrículas de 12, 20 o 28; crecimiento, puntuación y colisiones oficiales en el servidor | Jugar, flechas/WASD o botones táctiles |
| Circuito | Tres carriles, obstáculos y carrera de tres vueltas | Jugar, izquierda/derecha o A/D; arriba/W acelera y abajo/S frena |

## Requisitos y despliegue

Git, Node.js 22 y Docker Engine/Desktop con contenedores Linux y Compose v2
compatible con `up --wait`. La construcción necesita acceso a las fuentes e imágenes
de sus dependencias. Go, Scala y SWI-Prolog se incluyen en los contenedores.
No se requieren frameworks ni dependencias npm para la aplicación.

Mientras la [PR #1](https://github.com/JusMH/gameconsole/pull/1) siga abierta,
la versión SDK se encuentra en la rama `experiment/live-plugin-import`:

```powershell
git clone --branch experiment/live-plugin-import https://github.com/JusMH/gameconsole.git
cd gameconsole
node scripts/deploy.mjs
```

Abrir **http://127.0.0.1:3000/**. El despliegue prepara GameStats en el commit
`4adee854ea3b35148b1eadd0549d4d8e647b345c`, construye tres servicios y espera su salud:

| Servicio | Responsabilidad | Acceso predeterminado |
| --- | --- | --- |
| gameconsole | Node.js 22, plugins y SWI-Prolog | 127.0.0.1:3000 |
| go-ingestion | Recepción y consulta de eventos GameStats | 127.0.0.1:8080 |
| scala-analysis | Cálculo de métricas y patrones | DNS interno, puerto 9000 |

El preparador conserva cambios locales en `.deps` y resuelve las rutas Windows con
caracteres no ASCII mediante una copia de construcción. No modificar la dependencia
preparada. `PORT` y `GAMESTATS_PORT` permiten cambiar los puertos publicados.

```powershell
node scripts/deploy.mjs --stop
```

El apagado afecta al proyecto Compose `gameconsole`, sin borrar volúmenes ajenos.

## Cómo jugar

1. Elegir un juego en Biblioteca, configurar sus opciones y crear la partida.
2. Jugar en su panel; crear otras partidas, incluso del mismo videojuego, para
   ejecutarlas de forma independiente. Cuadrícula permite ver varias a la vez.
3. En cuadrícula, Ctrl + Alt + J/K enfoca el juego anterior/siguiente. También
   funciona desde los iframe; no intercepta campos editables ni teclas de movimiento.
   El navegador o sistema operativo puede reservar esas combinaciones.
4. Consultar estadísticas en la tarjeta y en el panel seleccionado. Las consultas
   son periódicas y acotadas; `null` o no disponible no se muestran como cero.
5. Finalizar administrativamente una partida o completar su objetivo. El historial
   conserva resultados y libera el iframe finalizado sin duplicar el cierre.

Jugar inicia Snake y Circuito; Pausa/Continuar controla la actividad local. Perder
foco libera teclas sin exigir otra activación. Ajustes permite suspender al ocultar
y reanudar al regresar; ambas preferencias están activadas por defecto. La reanudación
consulta el estado confirmado y una pausa manual se conserva. No es una pausa del
servidor ni modifica las duraciones calculadas por GameStats.

Nueva pestaña abre `/?match=<id>` y comparte la misma partida; no crea otro UUID.
Con Web Locks, una pestaña controla y las demás observan. Tomar control coordina
la transferencia; sin soporte se advierte que no se garantiza exclusividad.

## Integración con GameStats

El SDK confirma estado y eventos localmente; EventOutbox entrega los eventos a Go
en orden por partida. Scala calcula los resultados bajo demanda. **Confirmado,
entregado y analizado son estados distintos.** El navegador presenta métricas,
patrones y conteos oficiales sin recalcularlos.

Si Prolog falla después de confirmar una X, la jugada permanece y Reintentar IA
permite continuar. Si GameStats falla, las partidas pueden seguir confirmando
localmente mientras se informa la entrega o consulta pendiente. No se asegura
rollback de una operación cuyo resultado de transporte es desconocido.

## Pruebas y CI/CD

Para las pruebas locales se necesitan Node.js 22, SWI-Prolog en PATH
(o `SWIPL_PATH`) y Python 3 para los ZIP del importador (`py -3` en Windows).

```powershell
npm run check
node --test test/sdk-compose-integration.test.mjs
npm test
# Solo con el despliegue real listo y sin partidas abiertas/productores concurrentes:
npm run test:integration:sdk
```

`npm test` incluye pruebas históricas con Prolog y pruebas HTTP locales con dobles;
no levanta Docker ni Go/Scala. La integración SDK usa servicios ya desplegados y
genera `evidence/sdk-integration.json`. Las comprobaciones históricas
`npm run test:integration` y `node scripts/recovery.mjs` se conservan por separado.

GitHub Actions verifica Node 22, sintaxis, suite Node y Prolog en PR/main/manual.
El trabajo integrado construye Compose y ejecuta una integración SDK real en push
a main o mediante `workflow_dispatch` con `integration=true`; conserva evidencia
y apaga los servicios. El deployment del proyecto es local, no alojamiento remoto.
El estado verificable de CI y de la entrega se mantiene en [docs/entrega.md](docs/entrega.md).

## Importador experimental

El importador es adicional y está deshabilitado en el despliegue académico.
Su entorno independiente se inicia con `node scripts/deploy-importer.mjs` en
`http://127.0.0.1:3001/` y se apaga con el mismo comando más `--stop`.
Admite paquetes confiables `.game.zip` compatibles con el SDK y perfiles Scala,
no archivos JAR/Swing directamente. El equipo verificó la importación real de
Wall Defender con dos partidas y métricas Go/Scala. El rollback ante perfil inválido
y la victoria tras nueve oleadas siguen pendientes de comprobación manual.

Formato, permisos y uso: [importador experimental](docs/sdk-v1/phase-3i2-plugin-importer.md).

## Limitaciones y documentación

Las partidas, eventos pendientes y la idempotencia residen en memoria; reiniciar
Node/Go pierde sus datos respectivos. El límite es de 500 partidas por proceso
y 32 canales por HostBridge. No hay cuentas ni autorización global de jugadores;
Web Locks coordina solo el mismo navegador/origen. Los plugins Node son código
confiable: el sandbox del iframe no los aísla. Los temporizadores ocultos pueden
ser limitados por el navegador.

- [Arquitectura y decisiones](docs/arquitectura.md)
- [Contratos de integración](docs/integracion.md)
- [Estado de verificación y entrega](docs/entrega.md)
- [Referencia SDK e historial](docs/sdk-v1/README.md)
- [Guion interno de video](docs/video.md)
- [Repositorio GameStats](https://github.com/JusMH/gamestats)
