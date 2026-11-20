# Fase 3I.1 — Cuadrícula, estadísticas y teclado

Base: `0538ec987d0410d748b675b9aa81cda8963a2ac3`, rama
feature/gameconsole-sdk-v1. Cambios de navegador; no se modifican reglas, sesiones,
identidades SDK, Web Locks, transporte de eventos ni analítica.

## Pausa estable

SnakeController/RacingController distinguen una lectura explícita de sincronización
(syncing) de la operación normal busy. Mientras el bucle permanece armado, un tick
y su lectura posterior conservan Jugando / Pausa. No se omiten snapshots ni se
adopta el snapshot histórico de un replay como estado vigente.

Pausa sigue habilitada durante una acción normal en vuelo: desarma el bucle y libera
entradas, sin cancelar ni repetir la acción. Continuar queda deshabilitado hasta
resolver esa operación. La confirmación pendiente se conserva; no se promete rollback.
Los setters de controles comprueban el valor antes de escribir textos/propiedades.

La primera sincronización y recuperación muestran Sincronizando / Esperando
sincronización. Un error de red requiere recuperación explícita. RESULT_UNKNOWN
mantiene el bloqueo y recuperación del mismo messageId; no genera otro tick.
Pausa manual, preferencias de 3H, suspensión, observador y finalización mantienen
su semántica. Continuar corresponde a una decisión voluntaria, no a cada actualización.

## Resumen por partida

MatchWorkspace crea una región analítica propia para cada tarjeta, separada del
contenedor del iframe. En cuadrícula muestra hasta tres métricas en el orden
recibido, con label, value, unit y disponibilidad. Más métricas y patrones permite
ver el resto; su apertura se conserva al actualizar datos. El renderizador es el
mismo StatsPanel del panel lateral, con procedencia/basis/subjectId plegados.
No hay selección por gameId ni calculadoras de métricas. Null sigue siendo sin dato.

GridResultsCoordinator comparte las lecturas con el poller de la partida seleccionada:

- Única fuente: ConsoleAPI.results → GET /api/sdk/matches/:id/results.
- Solo observa iframe montados, no retirados y expuestos por el layout de cuadrícula
  de la sección Partidas. No recorre las sesiones no abiertas del servidor. La
  visibilidad es la del workspace; no calcula intersección exacta con el viewport
  al hacer scroll, igual que la política de presentación 3H.
- Máximo dos lecturas de resultados simultáneas entre cuadrícula y panel principal.
  Las peticiones de un mismo matchId comparten la promesa en vuelo. El panel principal
  tiene prioridad cuando espera en la cola; no se crea otra cola de acciones.
- Las tarjetas no seleccionadas consultan aproximadamente cada 5 s desde la última
  respuesta. Actualizar la selección/listado no reinicia indefinidamente ese plazo.
  No se solapan consultas por ID ni se repite inmediatamente una consulta fallida.
- La tarjeta seleccionada recibe el resultado del poller existente (3 s); no tiene
  otro polling paralelo. En modo enfocado no hay polling de cuadrícula. La consulta
  manual del panel principal sigue siendo una lectura fresca, salvo si comparte
  una petición ya en vuelo.
- Caché temporal en memoria por matchId, como máximo 64 entradas recientes. Conserva
  la respuesta íntegra; al volver a exponer una tarjeta puede mostrar el último
  resultado y volver a consultar cuando supere 5 s. No es persistencia ni autoridad
  analítica. Reiniciar la página pierde la caché.
- Cada publicación se vincula al frame e identidad observados al iniciar. Una vista
  desmontada/reemplazada no recibe su respuesta tardía. El panel principal conserva
  además sus generaciones de selección. No se remonta un iframe desde la analítica.
- Ocultar la pestaña retira observadores, cancela trabajo en cola y detiene el timer.
  Las lecturas ya enviadas pueden terminar, sin publicar sobre las vistas retiradas.
  Dispose aborta transporte y limpia cola, timer, observadores y caché.

HTTP 202 muestra entrega/análisis pendiente y no ceros. Un fallo muestra estado
fallido y, si existen, los últimos datos identificados como desactualizados.
Provisional, final, unavailable e invalid conservan su significado y reason.
GameStats caído no bloquea controles ni acciones del juego.

## Navegación y foco

En cuadrícula, sección Partidas y pestaña visible:

- Ctrl + Alt + J: juego anterior.
- Ctrl + Alt + K: juego siguiente.

Recorren circularmente solo vistas running, montadas y visibles. Se enfoca el iframe
existente y se marca Teclado aquí. Selección, estadísticas y enlace ?match se
actualizan sin reconstruir ni mover iframe. El foco nativo libera las entradas
sostenidas del anterior mediante el blur de 3H. Los otros juegos visibles conservan
su actividad; no se solicita ni transfiere ningún Web Lock.

Se ignoran repeticiones, inputs, textarea, select y contenido editable. Las teclas
normales de movimiento no se consumen. El navegador, sistema operativo, AltGr o
una extensión pueden reservar estas combinaciones; en ese caso usar la selección
con ratón/Tab y enfocar el juego. Los atajos son fijos en esta revisión; su edición
en Ajustes queda pendiente. No se interceptan atajos fuera de la cuadrícula.

Los keydown de iframe no burbujean al host. GameBridgeClient escucha la combinación
y envía un mensaje exclusivamente de presentación, sin promesa de acción SDK:

```json
{
  "protocol":"gameconsole.bridge", "version":1,
  "channelId":"<canal de 32 caracteres hex>",
  "type":"NAVIGATION_REQUEST", "messageId":"<ID válido>",
  "payload":{"direction":"next"}
}
```

Payload exacto: direction = previous | next. No admite matchId destino, rutas ni
acciones. HostBridge valida esquema, source, origen opaco y canal como antes;
deriva el matchId emisor desde su asociación y llama a onNavigate. ConsoleApp
decide el destino y descarta emisores que ya no están expuestos/running. Una ventana
desconocida o canal antiguo no navega. Se recuerdan hasta 32 IDs recientes por canal
para ignorar mensajes duplicados; las repeticiones físicas se filtran en el cliente.
La navegación no incrementa versiones, no consulta HTTP por sí misma y no emite
eventos. Cambiar selección puede activar la lectura analítica del panel existente.

La extensión es aditiva a Bridge v1. No cambia sandbox allow-scripts, CSP, orígenes,
PRESENTATION ni permisos. Un host sin onNavigate ignora la navegación. Al desmontar
el cliente se elimina su listener de teclado junto a los demás recursos.

## Pruebas ligeras

Suites nuevas: sdk-multigame-ux.test.mjs y sdk-bridge-navigation.test.mjs. Cubren
botones estables incluso durante snapshots lentos, pausa durante operación pendiente,
sincronización real/resultado incierto, cuatro resúmenes independientes, identidad,
202/503/null, límite de dos lecturas, deduplicación, cadencia, caché acotada,
respuestas tardías, foco desde host e iframe, pedales liberados y ausencia de remonte.
La regresión de 3H mantiene sus pruebas de exclusión y transferencia con Web Locks.
Se utilizan dobles de DOM, reloj, ventanas y analítica, sin instalar dependencias.

```powershell
node --test test/sdk-multigame-ux.test.mjs test/sdk-bridge-navigation.test.mjs
node scripts/check.mjs
git diff --check
```

Resultados: 18 pruebas nuevas aprobadas; regresión de SDK/Bridge/web/consola y
HTTP/Outbox, 316 pruebas aprobadas, cero fallos u omisiones. Sintaxis aprobada en
109 archivos y git diff --check sin errores. Node disponible: v24.21.0; Docker/CI
con Node 22 no se ejecutaron en esta revisión.

La comprobación real de foco, apariencia y atajos depende del navegador: los dobles
no la sustituyen. No se ejecutaron Docker, Prolog, Go/Scala, instalaciones ni navegador
automatizado durante esta fase. El reporte final registra los totales de regresión.

## Comprobación manual pendiente

1. Abrir tres o cuatro Circuitos reales, iniciar cada uno y elegir Cuadrícula.
   Cada tarjeta debe presentar métricas del UUID propio y la disponibilidad real.
2. Desde la consola y desde el interior del juego, alternar Ctrl+Alt+J/K. Confirmar
   foco y marcador correctos, liberación de acelerador/freno anterior y continuidad
   de los demás. Mantener la tecla no debe recorrer varios juegos por repetición.
3. Escribir en un control editable: el atajo no debe navegar. Probar con el navegador
   y SO de entrega para detectar combinaciones reservadas.
4. Pulsar Pausa durante una actualización lenta. Debe parar tras la operación en
   vuelo, sin parpadeo durante ticks normales ni un paso adicional posterior.
5. Abrir métricas completas y esperar consultas: deben conservarse accesibles.
   Ocultar la pestaña y volver; verificar que no aparecen respuestas de otro UUID.
6. Con GameStats indisponible, confirmar errores/pending sin ceros falsos y que los
   juegos siguen operativos. Volver al modo enfocado conserva panel completo e iframe.
7. Abrir la misma partida en otra pestaña y repetir los atajos: el observador no
   adquiere el Web Lock por enfocar. Tomar control conserva el flujo explícito de 3H.
