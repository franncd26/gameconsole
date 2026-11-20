# Estado de verificación y entrega

Proyecto 2 · Entrega prevista: **20 de noviembre de 2026, antes de las 22:00, Costa Rica**.
Este registro distingue implementación, pruebas locales y certificación del commit entregado.

## Funcionalidad y evidencia

| Área | Estado y alcance de la comprobación |
| --- | --- |
| Juegos académicos | Gato, Snake y Circuito como paquetes independientes, interfaces web, múltiples instancias y Bridge implementados. |
| Reglas e IA | Reglas oficiales en el servidor; Gato utiliza SWI-Prolog real. Las pruebas locales incluyen la suite histórica de Prolog. |
| SDK/HTTP/Outbox | Contratos, aislamiento, idempotencia, fallos y entrega cubiertos por pruebas Node; los dobles analíticos no certifican Go/Scala. |
| Integración real previa | El registro local `evidence/sdk-integration.json` contiene status=passed y transport=configured-http-services; incluye Prolog, entrega, resultados provisionales/finales y dashboard. |
| Importador experimental | El equipo comprobó despliegue e importación real de Wall Defender, dos partidas y métricas Go/Scala. No equivale a un cuarto juego académico. |
| Rollback experimental / victoria | Pendiente comprobación manual de perfil inválido y victoria de Wall Defender tras nueve oleadas. |
| CI del PR | El run enlazado abajo falló en verify por una prueba cancelada; integrated quedó omitido. La corrección local requiere publicación y una nueva ejecución. |
| Video | Guion interno disponible; grabación, publicación y enlace definitivo pendientes. |

El informe local de integración SDK comenzó el 19/11/2026 a las 23:49 de Costa Rica
(`2026-11-20T05:49:11.920Z`). Conserva IDs, eventos, source/basis y resultados de los
tres juegos. Es evidencia de esa ejecución previa; no certifica por sí solo la
revisión final del PR ni sustituye su pipeline integrado.

La comprobación manual del importador se registra a partir del informe del equipo;
no cuenta con un artefacto adjunto versionado.
Los informes `evidence/` se conservan fuera de Git y deben archivarse para la entrega.

## CI y corrección del plazo global

- [PR #1](https://github.com/JusMH/gameconsole/pull/1): experiment/live-plugin-import → main.
- [Run 44808432657](https://github.com/JusMH/gameconsole/actions/runs/44808432657):
  verify con 341 pruebas, 340 aprobadas, 0 fallos de aserción y 1 cancelada.
- La promesa sin transporte activo no mantenía vivo el event loop de Node.
  El plazo global usa ahora AbortController y un setTimeout referenciado, limpiado
  en finally; conserva GLOBAL_TIMEOUT, límites HTTP, cancelación y limpieza de partidas.
- Validación local con Node 22.13.1: cinco repeticiones de la suite focalizada sin
  cancelaciones; la suite ampliada pasa 342 pruebas. Sintaxis: 120 archivos.
  También se verifica la liberación del temporizador en éxito, fallo y error de evidencia.

La corrección no está certificada por GitHub Actions hasta publicarla y ejecutar
el workflow del SHA definitivo. La integración académica definitiva sigue pendiente
del job integrated; la ejecución manual previa no cambia ese estado.

## Lista de cierre

1. Revisar/publicar los cambios y conservar el SHA definitivo.
2. Ejecutar Actions en esa revisión: verify y workflow_dispatch con integration=true.
   Guardar URL, estado y artefacto sdk-integration; no reutilizar un run anterior.
3. Confirmar catálogo de tres, Gato/Prolog, Snake, Circuito, concurrencia, controles
   de teclado y estadísticas en el entorno que se mostrará en la entrega.
4. Archivar evidencia real y diferenciar datos de dobles, analítica provisional/final
   y confirmación local frente a entrega a Go.
5. Completar el [guion de video](video.md) con una grabación de 10–13 minutos,
   comprobar acceso al enlace y adjuntarlo a la entrega.
6. Si se presenta el experimento, identificarlo como adicional y no dar por probados
   los dos escenarios manuales aún pendientes.

El deployment es Docker Compose local, sin alojamiento remoto ni persistencia de
partidas entre reinicios. El importador persiste paquetes/perfiles, no sesiones.

## Herramientas de apoyo

Se utilizó Codex como herramienta de apoyo al desarrollo y revisión. La responsabilidad
sobre código, pruebas y entrega corresponde al equipo. La declaración formal deberá
ajustarse a la normativa del curso; este registro no presupone una política docente.

El [registro de verificaciones anteriores](verificacion.md) se conserva como historial
y no como certificación del commit definitivo.
