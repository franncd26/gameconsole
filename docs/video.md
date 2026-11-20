# Guion SDK — 12 minutos

Grabar únicamente una versión que el equipo haya construido y validado realmente.
No superar 15 minutos. No presentar scripts, capturas o un pipeline antiguo como
evidencia de ejecución nueva. El video público y su publicación quedan pendientes.

| Tiempo | Demostración |
| --- | --- |
| 0:00–0:45 | Autores, proyecto TEC, GameConsole y GameStats. Consola/SDK/Prolog frente a recepción Go y análisis funcional Scala. |
| 0:45–1:45 | Ejecutar o mostrar el deploy real preparado. Compose con tres servicios saludables, puertos loopback y catálogo SDK exacto. Prolog está dentro de Node. |
| 1:45–3:45 | Crear Gato con dificultad declarada. Colocar X y observar O de Prolog real. Mostrar una decisión/lastDecision, reglas privadas del paquete y resultado. |
| 3:45–5:00 | Crear Snake, seleccionar tamaño, activar controles, comer manzana y ver puntos confirmados/estadísticas. Mostrar cierre por colisión. |
| 5:00–6:45 | Circuito: activar, mantener acelerar, cambiar carril, observar obstáculos, vueltas y tiempos. Preparar una partida avanzada o editar esperas de la grabación con transparencia; no falsificar resultados. |
| 6:45–8:00 | Mantener los tres tipos abiertos juntos, identificar tres UUID. Seleccionar paneles sin destruirlos. Abrir ?match en otra pestaña y explicar que comparte la misma instancia. |
| 8:00–9:15 | Resultados de una partida aún open/provisional y luego final/closed. Dashboard con conteos por juego y generales, source/basis y entrega Outbox diferenciada de cálculo Scala. |
| 9:15–10:15 | POO: Rules/Session por paquete. Registry/Factory sin condiciones por gameId; Adapter/Facade de eventos/HTTP; Observer en Bridge/polling. No recalcular estadísticas en navegador. |
| 10:15–11:15 | Mostrar CI auténtica del commit entregado, job de build/integración y artefacto sdk-integration.json. Recorrer tres IDs, replay sin duplicados y verificación real Go → Scala. |
| 11:15–12:00 | Fallos: X confirmada ante dependencia fallida, RETRY_AI, entregas pendientes, null no es cero. Límites en memoria, README y apagado controlado. |

## Preparación de evidencia

- Validar previamente una ejecución integrada real, sin jugadores concurrentes.
- Mostrar URL/run/SHA verdaderos de Actions; si no existe, declararlo pendiente.
- El doble analysis-double y las demos con analítica SIMULADA no prueban Go/Scala.
- Los manifiestos permiten una instancia sin finalizar por tipo. Para repetir un
  juego, cerrar la anterior. Una pestaña nueva no elude esa política.
- Los juegos suspenden entradas automáticas al perder foco: usar continuar al
  cambiar de panel. No llamarlo pausa oficial del SDK.
- Evitar tokens, terminales con secretos, rutas privadas y notificaciones personales.
- Publicar el video con acceso comprobado y adjuntar su URL en la entrega. No se
  crea ni publica ningún video desde este encargo.
