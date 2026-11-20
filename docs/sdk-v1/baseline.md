# Baseline protegido — Fases 0 y 1

> Registro histórico. Describe la base anterior a la integración del SDK.
> Para uso y despliegue actuales, consultar el [README principal](../../README.md).

La inspección inicial encontró ambos árboles limpios en main. La evolución del
SDK comenzó en feature/gameconsole-sdk-v1 para mantener separada la base funcional.

| Repositorio | SHA observado |
| --- | --- |
| GameConsole | d986e4f13b3ebc5b22caaa97f90a994f2cc5ed5f |
| GameStats | a17543363bc418097e3179f76a7ebedfd85fa4a1, merge de PR #17 |

El SHA observado de GameStats no sustituyó el commit fijado en gamestats.lock.json:
4adee854ea3b35148b1eadd0549d4d8e647b345c. La reproducción del sistema utiliza el lock,
no la rama de trabajo del proyecto relacionado.

Las fases 0/1 añadieron validación, registro, documentación y fixtures aislados.
En ese estado, server/index.mjs aún no consumía el registro SDK y los juegos
históricos permanecían intactos. Las pruebas se limitaron a manifiestos/registro;
la integración, Docker y dependencias externas no formaron parte de esa verificación.

Los resultados anteriores y la evolución posterior se distinguen en
[verificación histórica](../verificacion.md) y [estado de entrega](../entrega.md).
