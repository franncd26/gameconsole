# Fase 3G — Multiinstancia y experiencia de consola

Base: `f9678963a0d088e0d7c306c9fb77ca57e499831c`, rama
`feature/gameconsole-sdk-v1`. Esta fase modifica presentación y capacidades
de los tres paquetes. Las decisiones anteriores de una partida por tipo quedan
sustituidas por esta política; los contratos de acciones y eventos se conservan.

## Aislamiento y política de instancias

Cada createSession construye una Session nueva con una única celda createState.
Gato conserva tablero, reglas y adaptador Prolog por sesión; Snake conserva cuerpo,
comida y fuente aleatoria por sesión; Circuito conserva física y reloj confirmado
en su propia celda JSON. Math.random/Date.now son fuentes de producción, no almacenes
de partidas. No se identificó estado mutable de dominio compartido en los módulos.

Los tres game.json cambian únicamente multipleInstances a true. GameInstanceManager
permanece intacto: un paquete con false sigue rechazando una segunda preparación
o partida sin finalizar con MULTIPLE_INSTANCES_DISABLED. Un fixture temporal cubre
esa política por HTTP. No hay condiciones por gameId ni un límite de tres vistas.
Siguen vigentes 500 partidas por proceso y 32 canales por HostBridge; finalizar
una vista libera su canal, pero no elimina la sesión del Manager.

Cuatro Circuitos tienen UUID, versiones, estados y eventos distintos. Dos Gato y
dos Snake pueden crearse desde clientes HTTP diferentes. Abrir /?match=<id> solo
consulta y monta otra vista de la misma sesión; no llama a create. Los conflictos
de versión entre pestañas siguen siendo responsabilidad del SDK/Bridge existente.

## Biblioteca, partidas e historial

ConsoleApp coordina tres secciones mediante hidden y mantiene sus componentes.
CatalogView genera opciones y textos desde los metadatos; el host no interpreta
acciones ni reglas por juego. Los nombres numerados son etiquetas de presentación;
los UUID se abrevian visualmente, conservando su valor completo en Diagnóstico,
enlaces y llamadas API.

MatchWorkspace mantiene un Map por matchId. Selección, navegación interna y modo
enfocado/cuadrícula cambian visibilidad/clases CSS: no remueven, recargan ni cambian
de padre los iframe vivos. La cuadrícula muestra las vistas que el usuario abrió;
recuperar el listado no monta automáticamente todas las partidas del proceso.
Al iniciar se selecciona preferentemente una partida sin finalizar. El historial
es un details plegado y separado de la lista activa.

Al observar finished:

1. Se conserva el snapshot oficial y se solicita el refresco genérico del Bridge.
2. La vista permanece hasta 1,8 s para mostrar el resultado del plugin. Si el
   transporte de ese refresco falla, el mensaje del anfitrión indica la finalización;
   no se garantiza que un iframe sin respuesta llegue a dibujar su pantalla final.
3. Se desmonta únicamente el iframe, se invalida su generación y se libera el canal.
4. Su tarjeta pasa al historial con snapshot, diagnóstico y resultados consultables.

Este proceso nunca llama a finish. Consultar una partida finished no monta otra
vista; Restablecer queda deshabilitado. Las sesiones, eventos y métricas no se
borran. Un cierre administrativo conserva el contrato existente: no fabrica una
victoria o un race_completed. El historial no sustituye almacenamiento durable.

Los refrescos mantienen el control de revisión/generación auditado en 3E.3: un
cambio posterior no se pierde, hay una lectura por iframe y desmontar invalida
las respuestas anteriores. Las lecturas de selección se descartan por generación;
snapshots antiguos o con otra identidad no reemplazan los vigentes. Además, una
creación confirmada invalida cualquier listado solicitado antes de crearla: ese
listado obsoleto no puede retirar el iframe recién abierto. Una regresión con
promesas controladas reproduce esta carrera al crear varias partidas seguidas.

## Estadísticas y controles

El panel de resultados permanece junto al área de juego. Presenta valores de
GameStats, estados de disponibilidad y advertencias; procedencia/basis/detalles
quedan plegados. No suma métricas ni convierte null a cero. Se conservan las rutas
SDK de resultados y /api/dashboard, polling de 3/5 s y suspensión por pestaña oculta.
Un fallo analítico no detiene las partidas.

Seleccionar otra vista puede quitar el foco a Snake/Circuito: sus controles web
existentes suspenden entradas y requieren continuar/resincronizar. Esto no implica
pause/resume del SDK. No se alteran esos controles ni la física para ocultarlo.

## Verificación ligera

Suites nuevas:

- sdk-multiinstance: cuatro Circuitos con reloj por sesión, versiones/colisiones/
  eventos aislados, creación HTTP concurrente de ocho sesiones de los tres juegos,
  lectura del mismo UUID desde dos clientes, replay, cierre único y fixture false.
- sdk-console-experience: cuatro vistas estables en foco/cuadrícula/secciones,
  creaciones consecutivas, listado tardío, retiro terminal, historial, preferencia
  activa al recargar, selección/refresh tardíos y limpieza de temporizadores/canales.

La regresión de consola HTTP usa SDK y Outbox auténticos con Go simulado y comprueba
que consultar el historial no monta un iframe ni genera otro MATCH_FINISHED.
Los tests existentes de Gato/Snake/Circuito se ajustan solo donde esperaban la
política anterior; el fixture genérico false permanece probado.

Ejecutar desde la raíz:

```powershell
node --test test/sdk-multiinstance.test.mjs test/sdk-console-experience.test.mjs test/sdk-console.test.mjs test/sdk-console-stats.test.mjs test/sdk-console-http.test.mjs test/sdk-multigame.test.mjs test/sdk-gato.test.mjs test/sdk-snake.test.mjs test/sdk-racing.test.mjs test/sdk-runtime.test.mjs
node scripts/check.mjs
git diff --check
```

El primer comando pasó 91 pruebas sin fallos. La regresión ampliada de 29 suites
focalizadas pasó 270 pruebas, sin fallos ni omisiones; incluyó SDK, Bridge, web,
HTTP/Outbox históricos y dobles de despliegue/integración. La sintaxis pasó en
103 archivos. git diff --check no detectó errores de espacios. Gato usa un adaptador falso en una
copia temporal del paquete; nunca ejecuta SWI-Prolog. No se ejecutaron Docker,
Go/Scala, navegador ni integración real durante esta fase. Los dobles verifican
contratos y procedencia de respuestas, no certifican analítica real ni apariencia.

## Comprobación manual del equipo

1. Revisar el diff y actualizar el despliegue con el procedimiento existente
   `node scripts/deploy.mjs` cuando el equipo autorice su construcción. Esta fase
   no cambia Docker ni CI. Verificar exactamente los tres plugins autorizados.
2. Crear cuatro Circuitos en Biblioteca, algunos desde otra pestaña. Cada creación
   debe producir un UUID distinto. Abrir Nueva pestaña de uno debe conservarlo.
3. Abrir cada partida y alternar Una partida/Cuadrícula, Biblioteca y Estadísticas.
   Comprobar que no se recargan las vistas y que cada control afecta su partida.
   Volver a activar controles al cambiar de foco si el plugin lo requiere.
4. Crear dos Snake y dos Gato; comprobar tableros/puntos independientes. Probar
   decisiones reales de Prolog exclusivamente en esta comprobación manual.
5. Consultar métricas por UUID y dashboard contra Go/Scala. Distinguir aceptación
   local, entrega y análisis; no usar los resultados de dobles como evidencia real.
6. Finalizar un Circuito. Tras el mensaje final y 1,8 s, su iframe debe desaparecer
   y los demás seguir abiertos. Consultar su historial sin nueva creación/cierre.
7. Recargar: preferir activas; el historial no debe llenar la pantalla de iframe.
   Abrir una URL de finished debe mostrar resultados, sin iniciar el juego.

Pendientes: revisión visual/responsive y de accesibilidad en navegador, ensayo
multijugador de pestañas con servicios reales y evidencia del despliegue actualizado.
No hay persistencia, autenticación nueva, cambios a Outbox/Bridge/SDK ni Wall Defender.
