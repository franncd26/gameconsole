# Fase 2B.2B — dispatch JSON, versiones e idempotencia en memoria

Se añade `await manager.dispatch(matchId, action)` como fachada de datos del SDK.
No se crean endpoints HTTP, frontend, cuentas, autenticación o autorización de
jugadores. Las clases históricas y su integración actual siguen independientes.
La [Fase 3A](phase-3a.md) añade OutboxEventSink y aceptación de lotes en Outbox;
el flujo real contra Go/Scala sigue siendo una comprobación manual pendiente.

## Contrato exacto

```js
const result = await manager.dispatch(matchId, {
  requestId: 'move-001',
  type: 'PLACE_MARK',
  payload: { index: 0 },
  expectedVersion: 0 // opcional
});
```

`matchId` identifica un registro del Map existente; nunca se interpreta como ruta,
URL o módulo. La acción admite exactamente tres campos obligatorios y uno opcional:

| Campo | Regla |
| --- | --- |
| requestId | String de 1–128 unidades UTF-16, sin caracteres Unicode de control (categoría Cc). No se recorta ni normaliza; los espacios son caracteres significativos. |
| type | String ASCII completo que cumple `[A-Z][A-Z0-9_]{0,63}`. No admite salto de línea final. |
| payload | Objeto JSON obligatorio. No admite null o array en su raíz; sí como valores JSON internos. El significado y las reglas son del plugin. |
| expectedVersion | Si está presente, entero seguro no negativo. Omitirlo no equivale a enviarlo con undefined/null. |

`actions.mjs` implementa `validateAction` reutilizando copyJSON/freezeJSON. Se copia
antes del primer await y se congela profundamente, sin invocar getters/toJSON.
Se rechazan campos desconocidos, funciones, accesores, ciclos, símbolos, fechas,
bigint, números no finitos, arrays dispersos y valores fuera del JSON admitido
por las utilidades (profundidad máxima 64). No se convierte texto en código ni se
importa un módulo desde la acción. Un texto dentro de payload sigue siendo un
dato; el host no lo interpreta como instrucción de sistema de archivos o shell.

La fachada entrega a `session.dispatch` únicamente la copia congelada del sobre.
No mantiene listas de acciones ni condiciones por gameId. Un type válido pero
desconocido para el juego llega al plugin, que puede devolver rejected. Solo las
sesiones que optaron por la celda/coordinador de 2B.2A pueden ejecutar esta API;
las anteriores siguen usando el ciclo de vida de 2A/2B.1 sin migrarse aquí.

## Orden de decisión y cola única

1. Copiar/validar el sobre y calcular su representación lógica. Un formato inválido
   produce INVALID_ACTION y no reserva requestId ni entra al plugin. Si existe la
   partida, el rechazo se ordena con su cola para obtener un snapshot consistente.
2. Localizar la partida y comprobar reentrancia antes de unirse a una promesa
   pendiente: una llamada desde la operación/callback que ya retiene su propia cola
   recibe REENTRANT_OPERATION, sin esperar esa cola ni su propia solicitud.
3. Si la misma requestId ya está en curso, el contenido igual comparte su promesa;
   el diferente obtiene REQUEST_CONFLICT en la cola, sin ejecutar otra acción.
4. En la cola existente de la partida, consultar primero el historial procesado.
   Contenido igual devuelve una copia del resultado original; diferente devuelve
   REQUEST_CONFLICT sin sobrescribirlo. Esto precede a estado y expectedVersion.
5. Para una solicitud nueva, exigir state running y celda coordinada. prepared,
   closing y finished reciben INVALID_LIFECYCLE; sin celda, COORDINATED_STATE_REQUIRED.
6. Comparar expectedVersion con la versión pública, dentro de la cola e
   inmediatamente antes de entrar al plugin. Una diferencia produce
   VERSION_CONFLICT: committed false, confirmations 0, snapshot vigente, sin
   invocar dispatch, cambiar estado/versión ni aceptar eventos.
7. Ejecutar mediante el mismo núcleo de runOperation, guardar el resultado y
   resolver con una copia defensiva. Las confirmaciones, acceptBatch y cierre
   condicionado al éxito de 2B.2A no cambian.

La extracción mínima del cuerpo de runOperation a `#runOperation(entry, operation)`
permite compartir el coordinador sin llamar a un método que vuelva a encolar
desde dentro de su propia cola. `runOperation` conserva su interfaz interna para
código confiable y pruebas anteriores. No se transmite esa función al cliente,
ni se devuelve la instancia del manager, sesión, contexto, sink o handles.

El alcance AsyncLocalStorage de la cola abarca también callbacks del ciclo de
vida/sink, de modo que tampoco pueden esperar un dispatch sobre la cola que
retienen. No existe una segunda cola de acciones. Otra partida conserva progreso
independiente. Las llamadas exteriores a getSnapshot/finish/activate/dispatch
siguen el orden de ingreso a la cola de esa partida.

## Identidad lógica de una solicitud

El fingerprint incluye todo el sobre, incluido expectedVersion si está presente.
Se construye una representación JSON canónica: claves de cada objeto ordenadas
por unidades de código de JavaScript, y arrays en su orden original. Se utilizan
JSON.stringify para claves y escalares ya validados, no para comparar objetos
sin ordenar. Los objetos anidados con las mismas propiedades en distinto orden
son equivalentes. Orden de arrays, tipo de valor, texto, mayúsculas y espacios de
strings siguen siendo significativos. No hay normalización Unicode. Los números
son valores JSON/Number: 1 y 1.0 son iguales; -0 y 0 se representan como 0.

Cambiar type, payload o expectedVersion bajo una requestId retenida genera
REQUEST_CONFLICT. Tras un VERSION_CONFLICT guardado, cambiar expectedVersion
requiere una requestId nueva. Un replay idéntico se comprueba **antes** de comparar
otra vez la versión: puede devolver su resultado aunque la partida haya avanzado,
esté closing o haya terminado. Ese replay nunca ejecuta una acción en un estado
prohibido; solo recupera un dato histórico.

## Ventana y expulsión

`new GameInstanceManager(factory, {eventSink, requestHistoryLimit: 128})` añade una
opción compatible con el constructor anterior. Valor predeterminado 128, rango
permitido de 1 a 1024 resultados por partida. Se mantiene un Map privado por
instancia, sin historial compartido por gameId ni entre managers.

La política es FIFO por finalización/procesamiento en la cola. Al insertar una
entrada nueva que excede la cuota se elimina la más antigua. Un replay no renueva
su antigüedad. Se guardan resultados completed, rechazos del plugin,
VERSION_CONFLICT y dependency_failed con o sin confirmaciones. El resultado
incluye el snapshot original, que no se sustituye por el de una acción posterior.
El manager congela su copia y devuelve clones independientes en cada respuesta.
Se clonan sobres generados por el host mediante structuredClone: no se reaplica
el presupuesto de profundidad del payload a cada envoltura adicional del resultado.
Los datos del snapshot ya fueron validados por el coordinador.

No se guardan formato inválido, partida desconocida, reentrancia, rechazo de estado,
ausencia de celda ni REQUEST_CONFLICT. Así, un rechazo en prepared no impide usar
la misma solicitud después de activar. REQUEST_CONFLICT tampoco reemplaza el
resultado original. VERSION_CONFLICT sí se conserva: su mismo ID/contenido no
debe transformarse después en una ejecución inesperada.

Un Map temporal adicional solo asocia requestId en curso con fingerprint/promesa;
no ejecuta operaciones y no es una segunda cola. Se elimina al resolver/rechazar
la primera llamada. Dos duplicados concurrentes se unen a esa promesa incluso
si otras solicitudes, ya en cola, expulsan posteriormente el resultado del FIFO.
La reentrancia se comprueba antes de compartirla para evitar esperarse a sí misma.

Después de expulsar una entrada, una solicitud puede volver a ejecutarse: no hay
garantía de idempotencia tras expulsión, reinicio, pérdida de memoria o con otro
manager/proceso. La cuota limita cantidad de resultados, no bytes globales ni
solicitudes simultáneas en espera. Límites de entrada, admisión y memoria total
para un transporte HTTP quedan pendientes. No se añaden timeouts aquí.

## Resultado público y fallos

```js
{
  outcome: 'completed', // rejected o dependency_failed
  committed: true,
  confirmations: 1,
  snapshot: { /* sobre público de la ejecución original o del conflicto actual */ },
  error: { code, message } // opcional, saneado
}
```

Los conflictos anteriores al plugin devuelven rejected/false/0. Si la partida no
existe, snapshot es null. Los errores normales de la acción son datos JSON, sin
stack, errores originales, rutas, funciones o referencias al estado mutable. Un
fallo inesperado de infraestructura rechaza con SDKError DISPATCH_FAILED y mensaje
fijo; no se inventa committed false tras un resultado desconocido. En ese caso se
debe consultar el snapshot y no asumir rollback/reintentar ciegamente. Un futuro
transporte deberá convertir excepciones del host a código/mensaje sin enviar stack.

Una transición confirmada seguida de fallo externo se guarda como dependency_failed
con committed true, confirmations y snapshot vigentes. Repetir requestId/contenido
recupera ese resultado sin repetir la transición. Continuar requiere una acción
explícita con otro ID, por ejemplo RETRY_AI. La aceptación local sigue sin probar
entrega a Go, persistencia, exactamente una entrega ni cálculo de Scala.

Si una acción solicita cierre y termina bien, se conserva el cierre idempotente
de 2B.1. El resultado finished puede recuperarse después usando el mismo ID. Si
el cierre fue rechazado por el sink, se guarda el resultado closing; un
manager.finish posterior puede completarlo, pero el replay de la acción devuelve
su reporte closing original. Para conocer el estado actual se consulta getSnapshot.
Las correcciones auditadas se conservan: una operación fallida no dispara el
cierre pendiente, y una segunda confirmación simultánea produce CONCURRENT_TRANSITION.

## Seguridad pendiente y verificación

Esto es una fachada de datos y concurrencia, **no autenticación/autorización**. No
se verifica titularidad ni permisos de clientes. Al crear endpoints se deberá
validar acceso a la partida y exponer solo los métodos aprobados: nunca enviar
el objeto manager ni permitir callbacks hacia runOperation. Los plugins siguen
siendo instalados/confiables dentro de Node, sin sandbox.

`test/sdk-actions.test.mjs` usa un paquete ficticio ensamblado temporalmente a
partir de fixtures existentes y `test/fixtures/sdk-actions/plugin.mjs`, con sink y
dependencia externos simulados. Verifica validación, clones, equivalencia JSON,
versiones, concurrencia, fallos parciales, historial, expulsión, cierre y
reentrancia. Se conservan íntegramente las cuatro suites SDK anteriores. No hay
pruebas HTTP, navegador, Go/Scala, Prolog o integración real.
