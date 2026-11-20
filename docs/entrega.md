# Verificación de entrega SDK

Entrega: **20 de noviembre de 2026, antes de las 22:00, Costa Rica**.
Separar preparación de código de evidencia real del commit entregado.

| Requisito | IMPLEMENTADO / inspección y pruebas ligeras | PENDIENTE DE VALIDACIÓN REAL |
| --- | --- | --- |
| Exactamente tres juegos | Paquetes Gato, Snake y Circuito; catálogo confiable | Catálogo desplegado y partidas completas manuales |
| POO y SDK genérico | Rules/Session, Registry, Factory/Manager, Facade y Adapter | Explicación en video sobre la versión entregada |
| IA auténtica | Adaptador SWI y programa privado del paquete | Una decisión real dentro del contenedor 3F |
| Concurrencia | Tres tipos simultáneos; UUID y cola por partida | Tres paneles y acciones en el despliegue |
| Instancias | Una sin finalizar por tipo, según manifiesto | Nueva pestaña comparte UUID; no contarla como otra instancia |
| Eventos v1 y transporte | Confirmaciones, EventSink/Outbox, replay y entrega ordenada | Nuevo sdk-integration.json contra Go real |
| Analítica Scala | Contratos/perfiles fijados; consola sin calculadoras | Métricas provisionales/finales, basis y source reales |
| Estadísticas generales | Dashboard cada 5 s; conteos oficiales y avisos | Correspondencia con eventos recibidos por Go |
| Docker reproducible | Imagen incluye paquetes; Compose activa SDK y tres servicios | Build, healthchecks y Prolog del contenedor |
| CI/CD | Verificación ligera y job integrado main/manual, artefactos y limpieza | Run del commit entregado con enlace y estado aprobado |
| Documentación y video | README de ejecución, detalles 3F y guion de 12 min | Grabar/publicar video, comprobar acceso y adjuntar enlace |

## Única validación controlada del equipo

1. Revisar el diff y conservar el SHA aprobado. Confirmar acceso a ambos repositorios.
2. Ejecutar `node scripts/deploy.mjs`. Esperar Scala → Go → consola saludables.
3. Abrir / y comprobar consola SDK y catálogo de exactamente tres plugins.
4. En entorno sin partidas abiertas/jugadores simultáneos, ejecutar
   `npm run test:integration:sdk` **una vez**. Un fallo no certifica ausencia de
   eventos: leer la etapa y cerrar solo las partidas de prueba que corresponda.
5. Guardar evidence/sdk-integration.json, sin modificarlo para aparentar aprobación.
   Debe indicar passed y configured-http-services; ningún doble sirve de evidencia.
6. Revisar manualmente Gato/Prolog, Snake y Circuito, controles de foco, tres
   paneles, estadísticas en vivo, cierre y recuperación mediante ?match.
7. Tras revisión/commit por el equipo, disparar Actions manualmente sobre esa rama
   con integration=true. Conservar URL/run/artefacto del SHA correcto; no reutilizar
   un pipeline anterior como prueba del nuevo cambio.
8. Grabar el video y verificar su enlace público, nombres de autores y privacidad.
9. Apagar con `node scripts/deploy.mjs --stop` y entregar en Tec Digital.

No se han ejecutado builds, Docker, Go/Scala/Prolog reales ni Actions durante
la preparación de 3F por Codex. La integración histórica y recuperación se
conservan, pero no se duplican automáticamente con la nueva integración SDK.
No hay alojamiento remoto ni persistencia de sesiones entre reinicios.
