# Guion de demostración — GameConsole

**Duración objetivo: 12 a 13 minutos. Límite: 15 minutos.**

La demostración debe realizarse con el deployment académico de **Gato, Snake y Circuito**, utilizando Go, Scala y Prolog reales.

| Tiempo aproximado | Demostración |
| --- | --- |
| **0:00–1:00** | Presentar GameConsole, las tecnologías y los tres servicios Docker saludables. Abrir la biblioteca. |
| **1:00–3:00** | Jugar Gato contra la computadora; explicar cómo el tablero llega a SWI-Prolog y cómo se ejecuta su decisión. |
| **3:00–4:30** | Jugar Snake, moverse, comer una manzana y observar los eventos y estadísticas. |
| **4:30–6:00** | Jugar Circuito: carriles, aceleración, obstáculos y registro de vueltas. |
| **6:00–8:00** | Mantener varias partidas abiertas; mostrar instancias distintas del mismo juego, la cuadrícula y otra pestaña que comparte una partida por ID. |
| **8:00–9:45** | Mostrar las estadísticas de cada partida mientras continúa y el dashboard general; explicar los conteos de instancias y la separación Go/Scala. |
| **9:45–11:15** | Explicar la arquitectura orientada a objetos, el SDK, las responsabilidades de las clases y los patrones Factory, Adapter y Observer. |
| **11:15–12:30** | Mostrar el deployment Docker y la [ejecución aprobada de CI/CD](https://github.com/JusMH/gameconsole/actions/runs/44814482222), incluyendo su integración real. |
| **12:30–13:00** | Resumir las limitaciones y concluir. |

## Preparación de la grabación

- Comprobar previamente los controles, audio y visualización de las tres interfaces.
- Preparar una partida que permita demostrar el progreso de Circuito sin simular resultados ni modificar las reglas.
- Mostrar métricas reales; las cifras provisionales y finales deben distinguirse de las no disponibles.
- Demostrar la concurrencia sin confundir una nueva vista de la misma partida con una instancia nueva.
- No mostrar credenciales, notificaciones privadas ni información personal innecesaria.
- Publicar el video con acceso verificable y colocar su enlace en [verificación y entrega](entrega.md).

El importador experimental puede mencionarse brevemente como extensión adicional, pero **no reemplaza la demostración de ninguno de los tres juegos obligatorios**.
