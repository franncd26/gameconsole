# GameConsole

Proyecto 2 de Lenguajes de Programación. Francisco Castillo y Justin.
Consola web con exactamente tres videojuegos: Gato contra Prolog, Snake y
Circuito de tres vueltas. Partidas independientes y panel consultado a GameStats.

## Ejecutar con Docker

Requisitos: Git, Node.js 22 o posterior para el preparador y Docker Desktop con
contenedores Linux. No es necesario instalar Go, Scala ni Prolog en la laptop.

```sh
git clone https://github.com/franncd26/gameconsole.git
cd gameconsole
node scripts/deploy.mjs
```

Abrir http://127.0.0.1:3000. El preparador descarga la versión de GameStats
fijada en `gamestats.lock.json`, construye y arranca los tres servicios.
En Windows, si la ruta contiene tildes, prepara una copia de construcción
en una ruta temporal sin tildes para evitar el problema de Docker del proyecto 1.
La primera construcción necesita Internet y puede tardar varios minutos.

```sh
node scripts/deploy.mjs --stop
```

El despliegue elegido es **local con Docker Compose**, equivalente a GameStats.
El repositorio y CI no representan alojamiento remoto. Los puertos se publican
solo en la propia laptop; Scala permanece dentro de la red Docker.
Para otros puertos configurar `PORT` y `GAMESTATS_PORT` antes de ejecutar.
Con la dependencia preparada y una ruta sin tildes también puede utilizarse
`docker compose up -d --build --wait` directamente.

## Jugar

- **Gato:** eres X; Prolog juega O. Selecciona casillas vacías. Minimax decide
  cada movimiento de la computadora; no se utiliza una selección aleatoria.
- **Snake:** pulsa Continuar y usa flechas o WASD. Cada manzana agrega 10 puntos.
  Chocar con la pared o el cuerpo termina la partida. Espacio pausa/reanuda.
- **Circuito:** pulsa Continuar. Mantén arriba/W o el control táctil para acelerar;
  abajo/S frena y los lados cambian carril. Completa tres vueltas; los obstáculos
  reducen la velocidad. Los tiempos incluyen las pausas de la partida.

Puedes abrir varias pestañas e iniciar partidas independientes. El botón
«Abrir en otra pestaña» crea una nueva instancia del mismo juego. La biblioteca
permite retomar partidas. Al cambiar de vista o pestaña se suspende el avance
del juego de reflejos/velocidad; las otras pestañas visibles pueden seguir jugando.
«Finalizar» cierra una partida abandonada. Cerrar la pestaña conserva la partida
para retomarla desde la biblioteca mientras siga vivo el servidor.

El panel consulta GameStats cada 2,5 segundos. Los datos cubren la sesión del
servicio Go: reiniciarlo elimina su historial. No hay persistencia de partidas.
Las instancias incluyen partidas activas y finalizadas, también abandonadas.

## Desarrollo y pruebas

Node.js 22+ y SWI-Prolog en PATH. No hay dependencias npm externas.

```sh
npm test
swipl -q -s prolog/gato_tests.pl -g run_tests -t halt
npm run check
npm start
```

Para el servidor local, GameStats debe estar accesible en `http://127.0.0.1:8080`;
puede configurarse `GAMESTATS_URL`. `SWIPL_PATH` permite indicar el ejecutable.

Con el sistema integrado iniciado:

```sh
npm run test:integration
```

La prueba crea seis partidas reales simultáneas, completa los tres juegos,
consulta Go/Scala y verifica aislamiento, entregas, métricas válidas y conteos.
Escribe `evidence/integration.json`. No borra partidas existentes y crea seis
instancias adicionales cada vez. Durante su ejecución no inicies otras partidas
si quieres verificar el incremento exacto de seis en los contadores generales.

## Documentación

- [Arquitectura y decisiones](docs/arquitectura.md).
- [Contrato de integración](docs/integracion.md).
- [Verificación de requisitos](docs/entrega.md).
- [Guion de demostración](docs/video.md).

La CI ejecuta pruebas de juegos, HTTP, Prolog y una integración Docker completa.
GameStats conserva sus suites Go/Scala y añade pruebas para el resumen agregado.
