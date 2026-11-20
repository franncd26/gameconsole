# Registro histórico de verificación

Este documento conserva las comprobaciones registradas el 18 de noviembre de 2026,
anteriores al despliegue SDK. No certifica la revisión actual ni su pipeline.
El estado vigente está en [entrega](entrega.md).

El registro de esa etapa consigna:

- 12 pruebas Node: reglas, opciones, aislamiento, fallos de Prolog, HTTP y Outbox.
- 10 pruebas Prolog, incluida exploración de continuaciones legales de la estrategia.
- Suite Go y go vet aprobados; detector de carreras aprobado en Linux Docker.
- 146 pruebas Scala, incluido análisis agregado y consultas de partidas abiertas/cerradas.
- Integración real de seis partidas concurrentes con eventos entregados y resultados válidos.
- Recuperación del envío tras pausar/reanudar Go, manteniendo eventos pendientes en Node.
- Construcción desde la carpeta del proyecto mediante una copia temporal sin tildes.
- Revisión de biblioteca, Gato/Prolog y estadísticas reales en navegador.

También se consignó una CI inicial aprobada y la verificación de descargas de sbt
con checksum. Este registro no incluye enlaces a esas ejecuciones; no deben usarse
como sustituto de la CI del commit definitivo.

Los archivos de evidencia se guardan fuera de Git en evidence/. La integración SDK
posterior y el estado del PR se documentan por separado en [entrega](entrega.md).
No se presupone persistencia de sesiones ni publicación del video.
