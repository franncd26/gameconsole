# Fase 3I.2 — Importador experimental de paquetes

Rama experiment/live-plugin-import, base 482e278e8febdbf36fe22adcf51e69d6bd7ea784.
Implementación preparada y comprobada mediante pruebas ligeras. **Docker, recarga
real de Java/Scala, permisos de bind mounts y navegador requieren validación manual.**
No se declara demostrado el recorrido real hasta ejecutar esa comprobación.

## Paquete .game.zip

Un ZIP contiene una sola carpeta raíz y un manifiesto SDK v1 sin modificaciones:

```text
mi-juego/
  game.json
  server/index.mjs
  web/index.html
  web/app.mjs
  web/assets/...
  analytics/profile.json
```

Se permiten más módulos propios y recursos. El servidor debe funcionar con módulos
ESM y APIs disponibles en el runtime; no se instala npm al importar. No hay soporte
para ejecutar directamente una aplicación JAR/Swing. Las reglas de manifestVersion,
sdkVersion, opciones, capacidades, entrypoints y rutas son las del validador SDK.
El directorio raíz del ZIP no decide la ruta final: se utiliza el ID validado.

El ZIP se maneja con **zipfile de Python 3**, biblioteca estándar mantenida. No hay
descompresor artesanal ni dependencia npm. Windows usa py -3; Linux, python3.
La imagen experimental incorpora Python; la imagen académica permanece igual.
El helper se ejecuta sin shell y con argumentos separados e intérprete aislado -I.

Límites: ZIP de hasta 10 MiB, 2048 entradas, 32 MiB expandidos, 4 MiB por archivo,
20 segmentos por ruta. Se admite STORE/DEFLATE sin contraseña. Se validan todas las
entradas antes de extraer, CRC durante lectura, duplicados sin distinguir mayúsculas,
rutas absolutas/traversal, symlinks, tipos especiales y nombres reservados Windows.
Los nombres de archivos/directorios son ASCII portátil; el contenido puede ser UTF-8.
El servidor web conserva su propio límite de 1 MiB y lista de extensiones permitidas.

Este experimento exige analytics.profile con gameId igual al manifiesto y al menos
una métrica verificable de event-metrics/v1 o duration/v1. Puede incluir otras
capacidades reconocidas por Scala; un perfil solo de patrones/analizadores especializados
no satisface esta prueba declarativa. Scala sigue siendo autoridad sobre la validez
completa de sus perfiles. No se duplican sus cálculos en JavaScript.

## UI y API

Biblioteca muestra Importar juego solo cuando el importador está habilitado:

1. Seleccionar un .game.zip.
2. Mostrar nombre, versión y descripción como texto, junto a la advertencia de confianza.
3. Confirmar explícitamente que se autoriza ejecutar el paquete.
4. Esperar instalación y verificación analítica.
5. Actualizar el catálogo y permitir crear partidas sin recargar la página.

| Ruta | Contrato |
| --- | --- |
| GET /api/sdk/plugins/import | {enabled,issues}; académico devuelve enabled:false |
| POST /api/sdk/plugins/import/preview | application/zip binario; devuelve {token,manifest,expiresInSeconds} |
| POST /api/sdk/plugins/import | application/json exacto {token}; 201 {status:"active",analytics:"verified",gameId} |

La vista previa comprueba archivos, manifiesto y perfil, **sin importar el módulo**.
Los tokens son de un solo uso, en memoria, con validez de 10 minutos; se conservan
como máximo cuatro vistas previas. Hay máximo cuatro solicitudes HTTP en curso y
ocho operaciones admitidas por el servicio; instalaciones y vistas previas se
serializan en una única cola del instalador, independiente de las colas de partidas.

Errores: 400 contrato/ZIP/perfil/interfaz inválidos; 403 origen no permitido; 404
importador deshabilitado/ruta; 405 método; 409 ID duplicado/vista previa expirada;
413 tamaño; 429 admisión; 503 activación o recuperación analítica pendiente.
No se devuelven trazas ni rutas locales. Un error de red al confirmar deja resultado
de instalación desconocido: actualizar catálogo antes de elegir nuevamente el ZIP.
No se reintenta automáticamente un token ni se promete rollback tras perder la respuesta.

POST requiere Origin del mismo host/puerto local: localhost, 127.0.0.1 o [::1].
El despliegue publica solo en loopback. Esto no es autenticación; **no publicar
este laboratorio en una interfaz de red pública**. Los módulos Node instalados
son confiables y ejecutan código con los permisos del proceso. El sandbox del
iframe no aísla ese servidor. No hay firmas, usuarios, OAuth ni marketplace.

## Registro dinámico y publicación

Se reutilizan Registry, Loader, Factory y el mismo Manager/Outbox del servidor.
PreparedSDK incorpora métodos internos para validar una candidatura y publicarla;
Registry vuelve a comprobar que sus metadatos/rutas siguen siendo los validados.
La autorización dinámica solo se añade después de completar la activación.
El catálogo se proyecta desde el registro vivo filtrado por IDs autorizados y los
assets usan webPackage igual que antes. No hay condiciones por gameId.

El paquete pasa de staging a su ruta persistente definitiva **antes de importar
sus módulos**, para que import.meta.url e imports relativos no queden ligados a
un directorio que luego desaparece. Todavía no está publicado ni autorizado.
Un registro/loader aislados verifican exports e initializationContract y una Factory
prepara/limpia una sesión con opciones y participantes predeterminados. Por ello,
el paquete experimental debe poder prepararse con los defaults del SDK. Esta
comprobación no crea una partida en el Manager, no consume cuota ni emite lifecycle.
Se exige createState: una sesión antigua sin celda no es ejecutable mediante el
dispatch público coordinado y se rechaza antes de publicar el perfil.

Después se publica el perfil mediante rename de un temporal en el mismo directorio,
se verifica Scala, se escribe el recibo autorizado y se publica el ejecutable
validado en el loader existente. No se reemplazan IDs ni código de sesiones activas.
No se implementan actualizaciones o desinstalación. Un recibo y un journal permiten
recuperar una publicación interrumpida; no se promete transacción durable frente
a fallos de disco ni aislamiento de un paquete Node malicioso.

## Persistencia y recuperación

Por defecto, datos del anfitrión bajo .local/importer/, ignorados por Git y Docker:

```text
data/packages/<id>/          paquete original extraído
data/enabled/<id>.json       autorización persistente, hash del perfil
data/transactions/           journal de publicaciones pendientes
data/staging/                ZIP y vista previa temporal
profiles/<id>.json           conjunto analítico compartido
control/loaded              acuse del supervisor; no es un endpoint
```

Node recupera únicamente paquetes con recibos válidos, vuelve a validar/preparar
y comprobar sus perfiles antes de autorizarlos. Se reconstruyen los perfiles
adicionales uno a uno, para que uno defectuoso no impida recuperar los restantes.
Los perfiles compartidos alterados se apartan como .bak antes de restaurar el contenido
autorizado. Recibos inválidos se informan como issues; los tres académicos permanecen.
Las vistas previas/journals pendientes se limpian sin tocar fuentes versionadas.
No se recuperan partidas: el nuevo Manager empieza vacío.

## Recarga y comprobación de Scala

GameStats continúa fijado a 4adee854ea3b35148b1eadd0549d4d8e647b345c, sin modificar
su código. Main.scala/Profiles.load cargan una sola vez; **no existe una API de reload**.

La imagen Scala experimental deriva de su imagen original e incorpora un supervisor
sh. Mantiene un hijo Java, observa hashes del directorio compartido y, al cambiar:

1. Detiene solo ese hijo, conservando vivos Node y Go.
2. Copia una instantánea del conjunto a /tmp y arranca Java con SCALA_PROFILES_DIR.
3. Espera disponibilidad; si falla, restaura el último conjunto sano y reinicia Java.
4. Publica atómicamente la huella SHA-256 del conjunto realmente cargado y sano.

Los tres perfiles originales permanecen en /app/profiles como base de recuperación.
El supervisor no calcula métricas. El healthcheck solo indica disponibilidad.
Node espera que control/loaded coincida con la huella deseada y luego hace POST
/analyze al Scala real con un snapshot sintético válido y cerrado, IDs nuevos,
participantes string y muestras declarativas. Exige identidad, source.templateId,
instanceId, profileVersion, basis.eventCount y al menos una métrica declarada con
status final y value no nulo. Esa prueba **no se envía a Go ni contamina su dashboard**.
La huella evita aceptar una respuesta del proceso anterior que reutilice IDs/versión.

Si falla, se retiran el perfil y paquete nuevos, se conserva el catálogo anterior
y se verifica la recuperación mediante un perfil original conocido. Si tampoco
se confirma recuperación, se informa ANALYTICS_RECOVERY_PENDING; no se inventa éxito.
Las consultas analíticas pueden fallar temporalmente durante el reinicio; la ingesta
Go y las partidas Node no se reinician. La entrega Outbox y el análisis siguen siendo
etapas distintas.

## Entorno experimental frente al académico

El compose.yaml y deploy.mjs originales conservan su comportamiento y exactamente
tres juegos. No se habilita el importador en ellos. El entorno separado usa:

```powershell
node scripts/deploy-importer.mjs
# http://127.0.0.1:3001/  (Go loopback :8081)
node scripts/package-import-demo.mjs
# Biblioteca → Importar juego → evidence/import-demo.game.zip → Confirmar
node scripts/deploy-importer.mjs --stop
```

Estos comandos **no fueron ejecutados por Codex**. Deploy usa prepare.mjs y el SHA
fijado, construye las imágenes base y las dos capas experimentales, inicia solo el
proyecto Compose gameconsole-importer y espera healthchecks. Stop no borra datos.
Conserva el tratamiento de rutas Windows no ASCII mediante copia de construcción;
los datos persistentes permanecen en sus directorios originales. El empaquetador
requiere Python 3 local y no sobrescribe un ZIP existente: elegir otro destino si existe.

Variables del host para rutas/puertos: GAMECONSOLE_IMPORT_DATA,
GAMECONSOLE_IMPORT_PROFILES, GAMECONSOLE_IMPORT_STATE, PORT y GAMESTATS_PORT.
Variables Node en Compose: GAMECONSOLE_IMPORT_ENABLED=1, GAMECONSOLE_IMPORT_DIR,
GAMECONSOLE_IMPORT_PROFILES_DIR, GAMECONSOLE_IMPORT_STATE_DIR y
GAMECONSOLE_IMPORT_SCALA_URL=http://scala-analysis:9000. SDK y los tres trustedIds
originales se mantienen. No se modifica el SHA ni se expone Scala al anfitrión.

Node escribe paquetes/perfiles como UID 1000. Scala UID 10001 solo lee perfiles
y escribe el acuse en control; Node monta control de solo lectura. El preparador
crea los bind mounts Unix con directorios 0777 para este laboratorio local, archivos
0644; Windows depende del mapeo de Docker Desktop. No es una política multiusuario
de producción. Deben probarse permisos en el sistema de entrega. No hay socket Docker.

## Fixture, pruebas y comprobación manual

test/fixtures/import-demo no se precarga ni reside en plugins/. Implementa contador
con createState/confirmTransition, evento COUNTER_INCREMENTED, Bridge público,
INCREMENT/COMPLETE, dos sesiones independientes y perfil event-metrics/v1. Permite
probar el siguiente juego sin añadir lógica al host.

Suites nuevas sdk-importer.test.mjs y sdk-importer-ui.test.mjs usan ZIP reales con
zipfile y SDK/Outbox/HTTP auténticos. Scala/red se sustituyen por dobles: no certifican
recarga Java. Incluyen interfaz inválida, traversal, duplicados, tamaños, persistencia,
rollback, concurrencia, catálogo/assets/Bridge, identidad del Manager, orígenes,
perfiles originales, acuse por huella, journal y confirmación explícita de UI.

```powershell
node --test test/sdk-importer.test.mjs test/sdk-importer-ui.test.mjs
node scripts/check.mjs
git diff --check
```

Resultado de esta revisión: 16 pruebas nuevas aprobadas y regresión ampliada de
332 pruebas aprobadas, cero fallos u omisiones. Sintaxis aprobada en 120 archivos;
git diff --check sin errores. Node disponible v24.21.0; ZIP procesados realmente
con Python local. No se ejecutaron Docker, Node 22 en contenedor, Java/Scala, Go,
Prolog ni navegador. La revisión de Compose/supervisor es estática.

Prueba manual integrada pendiente:

1. Arrancar el entorno experimental; comprobar tres servicios sanos y tres juegos.
2. Iniciar un Snake/Circuito original y conservar sus UUID/versión.
3. Empaquetar el fixture e importarlo desde Biblioteca. Comprobar progreso, logs
   SCALA_PROFILE_SET_READY y que no cambian IDs de contenedores Go/Node ni sus partidas.
4. Crear dos contadores, incrementar uno y verificar independencia, eventos en Go,
   métrica increments.match provisional y luego final al completar.
5. Comprobar en resultados source.profileVersion, basis y UUID correctos. No basta
   /health o analytics:"verified" de un test con doble como evidencia real.
6. Probar un perfil semánticamente inválido para Scala: instalación fallida, retiro
   del perfil, recuperación de resultados originales y ningún nuevo juego anunciado.
7. Reiniciar el entorno: recuperar juegos autorizados y perfiles, no sesiones.
8. Volver al despliegue académico: catálogo de exactamente tres e importación deshabilitada.

Límites: una instancia Node instaladora por almacenamiento compartido; sin instalación
distribuida, firmas ni sandbox Node. Código confiable que bloquee su import/fábrica puede
bloquear el proceso. El supervisor y bind mounts están preparados pero pendientes de
Docker real; tampoco se certificó el navegador. No se portó Wall Defender ni un JAR.
