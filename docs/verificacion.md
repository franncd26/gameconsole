# Evidencia de verificación

Revisión realizada el 18 de noviembre de 2026, hora de Costa Rica.

- 12 pruebas Node.js: reglas de los tres juegos, configuración, aislamiento, fallos
  de Prolog, API HTTP, reintentos y reconocimiento de duplicados.
- 10 pruebas Prolog, incluida exploración de todas las continuaciones
  legales del jugador para verificar que la estrategia de O no pierde.
- Suite Go y go vet aprobados. Detector de carreras aprobado en Linux Docker.
- 146 pruebas Scala aprobadas, incluyendo resumen vacío, partidas abiertas y
  cerradas, estabilidad de consultas y rechazo de duplicación de partidas.
- Integración real de seis partidas simultáneas completada con Node, SWI-Prolog,
  Go y Scala: todos los eventos entregados, resultados válidos y conteos correctos.
- Interrupción mediante pausa temporal del contenedor Go: juego activo, eventos
  pendientes conservados y entrega recuperada al reanudarlo.
- Instalación ejecutada desde la carpeta definitiva de Proyecto 2: descarga del
  commit fijado y construcción mediante una copia temporal sin tildes.
- Interfaz inspeccionada en navegador: biblioteca, Gato contra Prolog y panel
  de estadísticas con valores reales. Comprobaciones de diseño adaptativo.

La primera CI de GameConsole aprobó en GitHub. La ampliación de GameStats
aprobó sus seis trabajos tras añadir reintentos a una descarga intermitente del
lanzador sbt, manteniendo su checksum. Las ejecuciones posteriores se consultan
en las pestañas Actions de ambos repositorios.

Los informes de integración y recuperación se generan en `evidence/` y se
adjuntan como artefactos de CI. Los datos de demostración no son persistentes.
El video final y la entrega en Tec Digital requieren revisión humana.
