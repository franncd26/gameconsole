# Fase 3H — Actividad local, preferencias y control entre pestañas

Base `9553f39f43add6651342f61d0523ed516737c76f`, rama feature/gameconsole-sdk-v1.
El estado oficial y sus versiones siguen perteneciendo al SDK. Esta fase solo
cambia el navegador: no añade PAUSE/RESUME ni altera duraciones o métricas.

## Estados de presentación

| Estado local | Significado |
| --- | --- |
| ready | Conectado, pendiente del primer Jugar voluntario |
| playing | Bucle local armado, sujeto a una acción en vuelo |
| manuallyPaused | El jugador pulsó Pausa; visibilidad/foco no cancelan esta decisión |
| autoSuspended | La preferencia impide avanzar mientras la vista está oculta |
| spectator | Esta vista no posee el control interactivo |
| resyncing | Leyendo el estado confirmado o esperando completar una operación |
| uncertain | Una acción tiene resultado desconocido; no se generan más ticks |
| finished | El lifecycle oficial dejó de ser running; no hay bucle local |

Son estados de interfaz. Una vista suspendida puede corresponder a una partida
running. Closing también detiene las entradas; no se presenta como un juego activo.

## Preferencias y visibilidad

Ajustes expone pauseWhenHidden=true y resumeWhenVisible=true. Se guardan únicamente
en localStorage del anfitrión con clave gameconsole.presentation.v1. JSON inválido,
tipos incorrectos, propiedades extra y almacenamiento denegado recuperan defaults;
si no se puede guardar, los cambios siguen activos en esa pestaña. No se comparten
automáticamente cambios de preferencias entre pestañas ni se accede a storage desde
los iframe sandboxed.

ConsoleApp deriva la visibilidad efectiva de sección Partidas, modo enfocado o
cuadrícula, selección y document.hidden. Cuadrícula considera las vistas expuestas
por el layout, sin observar su intersección exacta al hacer scroll. Biblioteca y
Estadísticas ocultan las vistas. Seleccionar un panel estadístico adyacente no
oculta el juego ni lo pausa. Cambiar preferencias se propaga sin recargar/remontar.

Snake/Circuito empiezan con Jugar. Después el botón alterna Pausa/Continuar.
Blur solo libera direcciones y pedales sostenidos; no desarma el bucle. Al suspender
por visibilidad o control se limpian entradas y timers. Al regresar, autoResume
permite leer el snapshot antes de rearmar; con false se necesita Continuar.
Una pausa manual siempre permanece pausada. Nunca se restaura un acelerador/freno
sostenido anterior. Los intervalos objetivo siguen siendo 150/180 ms después de
terminar la operación previa, sin acumular pasos.

pauseWhenHidden=false permite mantener actividad local en segundo plano, pero
el navegador puede limitar timers. No se promete una frecuencia ni simulación
continua exacta. La física y sus tiempos siguen calculándose en el servidor.

## Extensión aditiva de Bridge v1

PRESENTATION es exclusivamente host → juego. Conserva el sobre protocol/version=1,
messageId y channelId existentes. Su payload tiene exactamente cuatro booleanos:

```json
{"visible":true,"canControl":true,"autoPause":true,"autoResume":true}
```

No acepta identidad, versiones, código ni claves extra. Usa las mismas comprobaciones
de origen, source, canal y tamaño que los mensajes anteriores. No habilita HTTP,
conexiones ni permisos nuevos. Sandbox sigue siendo allow-scripts y CSP permanece
intacto. Es compatible con consumidores que no se suscriben; el host no exige esta
capacidad para el handshake original.

HostBridge.setPresentation(frame,payload) conserva el último valor, incluso antes
de INIT. GameBridgeClient.onPresentation(fn) entrega copias defensivas y devuelve
unsubscribe; la suscripción tardía recibe el último valor. getPresentation() permite
consultarlo. DETACH/dispose lo borran. No modifica snapshots ni versiones.

El host aplica canControl=false también a ACTION_REQUEST manuales antes de enviar
HTTP y devuelve SPECTATOR. Las lecturas siguen permitidas. waitForIdle(frame)
espera acciones ya iniciadas, incluida su lectura posterior; no crea otra cola.
El resultado desconocido se conserva por messageId y bloquea una transferencia
cooperativa hasta resolverlo. Un snapshot por sí solo no prueba el resultado de
una acción. Se permite recuperar explícitamente la misma operación con el mismo ID;
no se crea una nueva automáticamente.

## Coordinación entre pestañas

PresentationCoordinator usa un Web Lock exclusivo gameconsole:match:<matchId>.
La adquisición inicial usa ifAvailable, sin steal. Solo el propietario habilita
acciones. Un observador lee snapshots: las actualizaciones de versión del listado
provocan refresh del Bridge, aproximadamente con el polling existente de 5 s.
No necesita emitir acciones ni reconstruye reglas para observar a otro cliente.

Tomar control en el observador encola una adquisición del mismo lock y publica
REQUEST_CONTROL por BroadcastChannel gameconsole.control.v1. El propietario primero
revoca canControl, libera entradas y espera el transporte en vuelo. Solo después
libera el lock; el nuevo propietario sincroniza antes de avanzar. La señal informal
no concede propiedad: lo hace Web Locks. UUID diferentes no comparten lock.
Cancelar solicitud aborta una adquisición pendiente; se puede solicitar de nuevo
tras resolver un fallo en la pestaña propietaria.

Una acción con resultado desconocido impide ceder automáticamente. La pestaña
original conserva el lock y puede recuperar la misma operación. Si BroadcastChannel
no está disponible, el observador puede esperar a que la otra vista cierre; no
se simula una transferencia mediante storage.

Finalizar, desmontar o sustituir una vista libera su recurso. Un desmontaje normal
espera el transporte conocido antes de liberar un lock adquirido. Las generaciones,
AbortController y los records retirados impiden que respuestas tardías reactiven
una vista. Cerrar/crashear el documento libera Web Locks por el navegador y **no
garantiza** esperar una petición HTTP en el servidor. Si una respuesta se pierde,
el servidor podría seguir ejecutando la acción: no se afirma rollback ni un bloqueo
global del servidor. Manager conserva la serialización y control de versiones.

Sin Web Locks, el juego de una pestaña funciona y muestra que no se garantiza
exclusividad; no se implementan leases inseguros. Si Web Locks existe pero rechaza
el acceso, la vista no obtiene control y muestra el error. La coordinación requiere
un navegador/contexto compatible y el mismo origen/perfil. No coordina equipos,
navegadores distintos ni endpoints HTTP ajenos al host. No es autenticación.

## Presentación y analítica

El área central y los canvas aumentan de tamaño manteniendo proporciones. Los
controles de consulta/recuperación e identidad quedan plegados. El panel estadístico
presenta las primeras tres métricas en el orden de GameStats y deja las restantes
y todos los patrones accesibles en Más métricas y patrones. No elige por gameId,
descarta datos ni calcula métricas. Estado, reason, source, basis y subjectId siguen
disponibles. Pending, datos antiguos y errores conservan su tratamiento anterior.

## Verificación y límites

Suites específicas nuevas: sdk-presentation.test.mjs y sdk-bridge-presentation.test.mjs.
Cubren preferencias corruptas/denegadas, pausa manual/automática, autoResume=false,
blur, cuatro políticas independientes, incertidumbre, transferencia con acción
pendiente, exclusión por UUID, BroadcastChannel controlado, cancelación/desmontaje,
limpieza y mensajes estrictos/canales/observadores. Las expectativas antiguas de
reactivación manual tras blur se actualizan a la nueva política; los demás casos
históricos se conservan. Los relojes, Web Locks, ventanas y transporte son dobles.

```powershell
node --test test/sdk-presentation.test.mjs test/sdk-bridge-presentation.test.mjs
node scripts/check.mjs
git diff --check
```

No se ejecutan Prolog, Docker, Go/Scala, instalaciones ni navegador automatizado.
Resultado: 28 pruebas nuevas aprobadas; regresión ampliada de 31 archivos SDK/HTTP/
Outbox, 298 pruebas aprobadas, cero fallos u omisiones. Sintaxis: 106 archivos.
El ejecutable disponible fue Node v24.21.0; la imagen y CI mantienen Node 22 y no
se ejecutaron en esta revisión. git diff --check no detectó errores de espacios.
No se certifica apariencia ni comportamiento real de Web Locks mediante un doble.

## Prueba manual breve

1. En un despliegue actualizado, iniciar Snake/Circuito una vez. Hacer clic en
   estadísticas adyacentes: debe continuar sin reactivar controles; los pedales
   sostenidos se liberan al perder foco.
2. Ir a Biblioteca/Estadísticas y volver. Con defaults, se suspende y resincroniza
   antes de continuar. Con autoResume=false, debe mostrar Continuar. Probar Pausa
   manual y verificar que no se cancela por navegación.
3. Deshabilitar pauseWhenHidden y repetir. Verificar preferencias tras recargar,
   sin asumir cadencia exacta cuando la pestaña está oculta.
4. Abrir la misma partida en otra pestaña. Con Web Locks, la segunda es observadora.
   Pulsar Tomar control: la primera suspende entradas y la segunda sincroniza.
   Transferir durante una respuesta lenta; no debe haber dos bucles emisores.
5. Abrir cuatro Circuitos distintos: cada uno tiene control independiente; alternar
   foco/cuadrícula sin recargar sus iframe. Finalizar/desmontar uno no afecta al resto.
6. Provocar una respuesta desconocida en un entorno de ensayo: no debe reintentar
   ni transferir automáticamente. Recuperar la misma operación antes de continuar.
7. Ver métricas y procedencia Go/Scala reales; los cambios son de presentación,
   no una modificación de los tiempos analíticos durante una suspensión local.

Pendiente esta comprobación de navegador y servicios reales por el equipo. No se
han cambiado reglas, sesiones, manifiestos, analítica, Docker ni CI.
