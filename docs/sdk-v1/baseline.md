# Baseline protegido — Fase 0

Inspección inicial: ambos árboles limpios, ambos en `main`, sin cambios locales
ajenos. Se creó `feature/gameconsole-sdk-v1` antes de escribir archivos.

| Repositorio | SHA observado antes de cambios |
| --- | --- |
| GameConsole | `d986e4f13b3ebc5b22caaa97f90a994f2cc5ed5f` |
| GameStats | `a17543363bc418097e3179f76a7ebedfd85fa4a1` (merge PR #17) |

La referencia histórica de `gamestats.lock.json` sigue siendo
`4adee854ea3b35148b1eadd0549d4d8e647b345c`. El SHA local observado de GameStats
no se utiliza para actualizar ese lock ni `.deps`. El README histórico contiene
información anterior al merge de PR #17; esta tarea no lo reescribe.

No se encontró `GameConsole_SDK_v1_Decisiones_y_Contrato_Arquitectonico.docx` en
los repositorios inspeccionados. Se usan como referencias el encargo, el código
local y `docs/arquitectura.md` / `docs/integracion.md`.

La evidencia de funcionamiento previo (juegos, múltiples instancias e integración
pasada) fue aportada por el usuario; no se reproduce aquí. La protección consiste
en una rama nueva, documentación del SHA y cambios exclusivamente aditivos:
`server/sdk/`, `docs/sdk-v1/`, `test/sdk-v1.test.mjs` y su fixture. Sin commits,
push, merges ni modificaciones de GameStats o de archivos históricos.

La revisión de esta fase debe comprobar el diff, la ausencia de imports SDK en
`server/index.mjs` y las pruebas aisladas indicadas en el README de esta carpeta.
No se ejecutan Docker, servidores, navegador, integración, recuperación, Prolog,
Go, Scala, sbt, instalaciones ni descargas.

Después de revisar el código, el equipo podrá ejecutar por su cuenta la regresión
habitual de los tres juegos, múltiples instancias, eventos y resultados con
GameStats, así como Docker e integración. Es una comprobación posterior a cargo
del equipo, no evidencia producida por esta fase ni una integración del SDK.
