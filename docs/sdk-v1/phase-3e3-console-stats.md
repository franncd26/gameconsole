# Fase 3E.3 — Consola SDK y estadísticas

Base `4342ad6b7f7648d47fbec0cb38e586ea976621ad`, rama
`feature/gameconsole-sdk-v1`. Implementa la aplicación anfitriona sobre las rutas
y Bridge existentes. No cambia reglas, sesiones, opciones normativas, perfiles,
Outbox, Factory/Manager/Registry, GameStats ni la interfaz histórica.

## Composición y rutas

| Componente | Responsabilidad |
| --- | --- |
| `public/sdk/console.html`, `console.css`, `console.mjs` | Documento, diseño adaptable y composición inicial. |
| `console-app.mjs`: ConsoleApp | Creación, recuperación, selección, cierre y ciclo de vida de la página. |
| `console-api.mjs`: ConsoleAPI | Facade HTTP, codificación de IDs, tipos de respuestas y errores saneados. |
| `console-views.mjs`: CatalogView | Tarjetas desde metadatos y formulario de opciones declaradas. |
| `console-views.mjs`: MatchWorkspace | Map por matchId con contenedor estable e iframe. |
| `console-views.mjs`: StatsPanel | Presentación literal de resultados y agregados analíticos. |
| `console-stats.mjs`: PollResource | Observer, consulta única en vuelo, generaciones, visibilidad y limpieza. |

`GET/HEAD /` sirve `public/sdk/console.html` solamente si createApp recibió un
SDK preparado. `/?match=<id>` sirve el mismo documento, sin redirección ni
pérdida de query. `/sdk/console.html` permanece accesible directamente. Con SDK
apagado `/` sigue sirviendo exactamente el HTML histórico y sus módulos/rutas.
La consola explícita, si se abre con SDK apagado, muestra el error recuperable
SDK_DISABLED. No inventa un catálogo de respaldo.

La modificación del router es únicamente la elección del archivo raíz. Se
conservan CSP, frame-ancestors none, frame-src self, nosniff, Origin y la política
sin CORS de la API. CSS y ESM son externos y del origen actual; no hay CDN,
dependencias ni nombres de juegos, controles o acciones codificados en el host.

## Biblioteca y creación

GET `/api/sdk/catalog` determina nombre, descripción, categoría, capacidades,
participantes y opciones. No existe un catálogo duplicado. El formulario aplica
defaults y usa checkbox para boolean, select para enum/integer con values, input
number con step=1 y min/max para intervalos enteros, e input text con límites para
string. Conserva tipos JSON al leerlo. La API sigue validando oficialmente.

POST `/api/sdk/matches` recibe `{gameId, options}`; se omite players y se usan
los defaults del contrato de inicialización. No se personalizan participantes por
juego. Se protege el formulario y la operación por ID de plugin contra doble clic,
sin bloquear los formularios de otros plugins. No hay reintento automático de
creación: una respuesta perdida puede haber creado una partida, por lo que se
actualiza el listado SDK antes de que el usuario decida volver a intentar.

La respuesta confirmada crea un panel, monta el iframe, selecciona la partida e
inicia sus consultas de resultados. Se vuelve a leer el listado del servidor.
Si multipleInstances=false y ya existe una partida sin finalizar, se ofrecen
Abrir partida existente y Finalizar la existente. Un 409 del servidor refresca
el listado y abre la existente, sin repetir create. Una partida closing también
ocupa esa plaza. Con multipleInstances=true el formulario conserva Crear partida.
No cambia la política vigente de los tres manifiestos.

## Partidas, iframes y pestañas

GET `/api/sdk/matches` recupera las partidas del proceso, y GET
`/api/sdk/matches/:id` obtiene el estado actual antes de abrir/remontar una vista.
Nombre de catálogo, gameId, matchId, lifecycle, versión y entrega saneada se
presentan sin reconstruir datos de dominio. El listado se consulta cada 5 s.

MatchWorkspace conserva un Map por matchId. Selección, nuevas estadísticas,
actualización del catálogo y del listado solo modifican textos/clases; no
reconstruyen el árbol que contiene los iframe. Cambiar de sección usa anclas
del documento, sin eliminar vistas ni terminar partidas. Se pueden montar N
plugins; se respeta el límite real de 32 canales simultáneos de HostBridge, con
un mensaje recuperable y desmontaje explícito, sin imponer tres juegos.

Desmontar vista elimina solamente ese iframe. Remontar vista retira explícitamente
la vista anterior si todavía existe, obtiene snapshot y crea un iframe nuevo
mediante HostBridge.mount; nunca reutiliza el retirado. Es también la recuperación
manual ante una navegación del documento o canal invalidado.
Las partidas permanecen en el servidor. Tras recargar, se recupera el listado;
se monta la partida de la query o una primera partida del listado, y las demás
se abren bajo demanda, evitando montar automáticamente hasta 500 iframe.

Nueva pestaña apunta a `/?match=<id>` en el mismo origen, con noopener. La nueva
pestaña consulta ese ID y catálogo, sin llamar a create. Conserva la misma
identidad, con un canal Bridge propio; no es otra instancia SDK. No hay bloqueo
entre pestañas ni autorización nueva: expectedVersion y requestId siguen bajo
responsabilidad de Bridge/SDK. Un ID inexistente se informa, sin crear sustitutos.

Las copias de snapshots son exclusivamente de presentación. Se descartan
versiones menores y regresiones de lifecycle en la misma versión. La respuesta
de una selección anterior no puede abrir otra identidad encima de la más reciente.
Si el listado deja de contener un ID tras un reinicio, su vista se desmonta y se
retiran su tarjeta y controles. Si estaba seleccionado, se invalidan las lecturas
pendientes y las consultas de resultados; se puede seleccionar otra partida
disponible. Un callback antiguo no puede finalizar un ID retirado ni una respuesta
de cierre tardía recrear sus controles. No se promete persistencia del servidor;
una operación ya enviada antes de la desaparición puede completarse en el servidor.

## Cierre administrativo

POST `/api/sdk/matches/:id/finish` usa el motivo estable `user_finished`, con
guardia independiente por partida. Un snapshot finished conserva el panel para
revisión, deshabilita finalizar y actualiza el resultado final. Closing se muestra
como tal y ofrece Reintentar cierre; no se simula su confirmación.

Si la respuesta de finish falla, primero se consulta snapshot (incluido el que
pueda acompañar al error). No se repite finish automáticamente ni se afirma
rollback. Se muestra si finished quedó confirmado, si sigue closing o si no
pudo establecerse el resultado; el reintento siempre es explícito.

**Extensión mínima de HostBridge:** `await host.refresh(frame)` vuelve a leer la
API autorizada y publica SNAPSHOT por el canal ya asociado. No acepta identidad
ni snapshots del cliente, no recarga la página, no crea otro INIT ni cambia el
protocolo. Devuelve true cuando pudo publicar, false si había una lectura en
vuelo o falló el refresco; una vinculación inexistente/no preparada rechaza con
BRIDGE_NOT_READY. Mantiene comprobaciones de generación, source y canal. Si el
refresco queda pendiente, la vista conserva una marca y lo reintenta al actualizar
el listado (5 s o botón manual), sin solapar refrescos por iframe. Al inicializar
un canal también puede recuperar ese refresco pendiente. Se usa ante un cambio
de lifecycle o un refresco pendiente; no se consulta cada iframe en cada polling.

Cada cambio de lifecycle incrementa una revisión pendiente. Una lectura exitosa
solo reconoce la revisión con la que empezó: si pasó closing → finished durante
esa espera, se vuelve a leer después de concluir la primera, sobre el mismo iframe
y sin solapamiento. Un false/rechazo conserva la marca pero espera al siguiente
polling/refresco manual, sin reintentos inmediatos en bucle. El desmontaje invalida
la generación del iframe: las respuestas y finally antiguos no cambian las marcas
ni liberan la guardia de un montaje nuevo. Se rechaza un gameId distinto para un
match ya asociado; HostBridge conserva sus verificaciones de identidad al publicar.

Corrección de auditoría sobre `85d29f432019627306f0093899b990331986484a`:
las dos reproducciones iniciales fallaron antes del arreglo. Se añadieron siete
pruebas de regresión con promesas controladas; la suite de consola tiene ahora
20 pruebas. La verificación focalizada consola/Bridge/web/HTTP/Outbox aprobó
103 pruebas sin fallos ni skips, más sintaxis de tres archivos y git diff --check.
No se ejecutaron navegadores ni servicios externos para esta corrección.

## Procedencia de las estadísticas

- `/api/dashboard`: el host consulta Go `/dashboard`; Go reúne snapshots y Scala
  calcula el agregado. Se representan source, scope, consistency, totals y games
  del contrato real fijado (`gameconsole-dashboard.md`, `Summary.scala`).
- `/api/sdk/matches/:id/results`: el host deriva gameId de la sesión, espera que
  el prefijo local esté entregado y consulta Go/Scala. La consola no calcula
  métricas ni envía eventos.
- El listado SDK representa las partidas de la consola; el dashboard representa
  MATCH_STARTED/eventos efectivamente recibidos por Go. **No se suman sesiones
  SDK para sustituir los conteos oficiales.**

Los conteos iniciadas/activas/finalizadas/eventos y las métricas de cada juego se
muestran literalmente. Todo plugin del catálogo tiene sección aun sin datos de
GameStats; se distingue Sin datos de un cero numérico devuelto. También se
representan juegos adicionales enviados por GameStats. invalidSamples>0 advierte
que ese agregado es parcial; no se recalcula ni promedia ningún resultado.

Por partida se representan label/id, scope, subjectId, unit, status, value o count,
reason, source, basis.eventCount y occurrences de patrones. Null es Sin dato,
nunca cero. Los objetos estructurados se presentan como JSON de texto, sin
interpretar resultados del tablero ni etiquetas específicas de videojuegos.
Se conservan provisional/final/unavailable/invalid. Todos los datos se escriben
mediante textContent/elementos DOM, nunca HTML procedente del servicio.

200 muestra resultados; 202 entrega/análisis pendiente limpia las métricas
actuales y no fabrica ceros. 404 se informa como partida/resultados no disponibles;
502 como respuesta fallida/inválida; 503/504 como servicio indisponible/tardío.
Tras un error de actualización se pueden conservar los últimos datos correctos,
**marcados expresamente como desactualizados**, con hora de la última consulta
correcta en Costa Rica. Los mensajes no contienen trazas, rutas o errores crudos.

## Polling y aislamiento

Dashboard cada 5 s; resultados de **solo la partida seleccionada** cada 3 s;
listado SDK cada 5 s. Los intervalos comienzan después de concluir la consulta,
sin acumulación ni consultas simultáneas del mismo recurso. Los refrescos
manuales comparten la consulta pendiente. Al seleccionar se consulta inicialmente;
al finalizar se invalida la consulta anterior y se solicita el resultado final.

Cada recurso tiene generación y AbortController. Una respuesta de otra selección
o anterior a una invalidación se descarta, incluso si el transporte ignora abort.
La consulta siguiente espera que se asiente la previa, sin solaparlas. No hay
WebSocket, SSE, caché persistente ni cálculo analítico local. Los observadores
reciben copias defensivas y permiten unsubscribe.

Con documento oculto se detienen temporizadores, se abortan lecturas y se ignoran
respuestas tardías; al volver se actualizan los recursos vigentes. Una caída del
servicio analítico no desmonta iframe ni detiene acciones. Pagehide limpia polling,
suscripciones, listeners y todos los canales/vistas de esta página. Cerrar una
pestaña no finaliza partidas del servidor y no promete cancelar acciones en curso.

## Ejecución y demostración

Con Go/Scala ya disponibles, desde la raíz de GameConsole:

```powershell
$env:GAMECONSOLE_SDK_ENABLED='1'
$env:GAMECONSOLE_PLUGINS_DIR=(Join-Path (Get-Location) 'plugins')
$env:GAMECONSOLE_TRUSTED_IDS='tic-tac-toe,snake,racing'
$env:GAMESTATS_URL='http://127.0.0.1:8080'
node server/index.mjs
```

Abrir la URL que imprime el servidor. Para proxies HTTPS, conservar
GAMECONSOLE_PUBLIC_ORIGIN conforme a 3E.1; no se confía en cabeceras reenviadas
del cliente. Sin SDK/configuración de plugins se mantiene el arranque histórico.
No se inicia Docker ni servicios analíticos desde la consola.

Demo opcional **solo con analítica simulada**, limitada a cinco minutos:

```powershell
node scripts/sdk-console-demo.mjs
```

El script importa un doble claramente separado en
`test/fixtures/sdk-console/analysis-double.mjs`. No instala plugins adicionales ni
perfiles. Los resultados están rotulados SIMULADO; no implementan los perfiles
de Scala. La consola productiva no incluye esos valores ni importa ese doble.
La demo no inicia Go/Scala/Prolog; Gato requiere SWI-Prolog si el equipo decide
jugarlo manualmente. Ctrl+C solicita apagado, y existe un límite de cinco minutos.

Comprobación breve realizada en el navegador integrado: catálogo y tamaño 12 de
Snake; creación de las tres partidas; tres INIT y vistas concurrentes; aceleración
real de Circuito hasta velocidad 64 y v6; cierre administrativo a finished v7
sin recargar el iframe; métrica del doble pasó de provisional a final y el
dashboard mostró 3 iniciadas, 2 activas y 1 finalizada. Otra pestaña con el mismo
matchId recuperó finished v7, sin crear una cuarta instancia. No aparecieron
errores/avisos de consola. Una captura conjunta y cierre correcto de demo/tabs.
No se pulsó Gato ni se ejecutaron servicios reales. **Esto no certifica Go/Scala
real en 3E.3.** El equipo debe repetir con sus servicios para validación final.

## Pruebas y límites

Suites focalizadas:

```powershell
node --test test/sdk-console.test.mjs test/sdk-console-stats.test.mjs test/sdk-console-http.test.mjs test/sdk-bridge-host.test.mjs
```

Cubren los cinco tipos de opciones, N plugins, doble clic, múltiples instancias
según metadatos, identidad compartida por query, recuperación, conservación de
iframe, desmontaje/remonte, cierre perdido/closing/reintento, refresco Bridge,
200/202/404/502/503/504, métricas estructuradas, null, invalidSamples, conteos
oficiales independientes del SDK, polling, respuestas tardías y limpieza. La
integración HTTP usa SDK/Outbox y paquetes auténticos con transporte simulado,
sin Prolog. Se conserva la regresión de las interfaces web y SDK/HTTP/Outbox.

Resultado final: **241 pruebas aprobadas, 0 fallos, 0 skips** en las 25 suites
focalizadas (incluidas las anteriores de SDK, plugins, web, HTTP y Outbox).
Las tres suites nuevas y la suite Bridge ampliada suman 39 pruebas aprobadas.
`node --check` pasó en los 14 archivos ESM nuevos/modificados de esta fase;
`git diff --check` pasó. No se ejecutó npm test, test/games.test.mjs con Prolog,
servicios reales, instalaciones, Docker ni pruebas de carga. La única demo de
navegador fue local y acotada, con analítica marcada como simulada.

La API permanece local/de desarrollo: Origin no autentica usuarios ni garantiza
titularidad de partidas. Historiales e instancias siguen en memoria y los límites
del SDK/Bridge no cambian. Múltiples pestañas pueden generar conflictos de versión.
Pendientes: prueba final del equipo con Go/Scala y Gato/Prolog reales, accesibilidad
en dispositivos, Docker/CI/CD/despliegue y video. No se declaran cumplidos aquí.
