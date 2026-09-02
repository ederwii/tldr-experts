---
title: Dashboard
---

# Dashboard

`tldrx dashboard` dibuja el workspace como una sola página web. Es de **solo lectura**: no
hay un botón ahí que cambie un archivo, porque un dashboard que puede lanzar trabajo es una
segunda fuente de verdad compitiendo con los archivos.

```bash
tldrx dashboard              # un servidor vivo en 127.0.0.1, que se redibuja al cambiar los archivos
tldrx dashboard --static     # escribe un index.html autocontenido y se detiene
tldrx dashboard --static --out ./somewhere/page.html
```

El servidor vivo vigila el workspace y manda un reload cuando cambia algo debajo de él. La
exportación estática es un solo archivo con el CSS, el JavaScript y los datos incrustados —
ninguna referencia de red, de ningún tipo —, así que se ve igualito sin internet y no filtra
nada sobre quién la abrió. Los dos son el mismo documento; lo único que cambia es si vigila.

## Qué muestra

| Vista | Qué trae |
|---|---|
| Runs | Cada run, su estado, el avance por fase, el gasto, y **qué está esperando**. El que puedes retomar ahora mismo lleva `← next`, la misma marca que imprime `tldrx status`. |
| Un run | El camino de ejecución etapa por etapa — experto, modelo, costo, compuerta, quién la firma y quién la firmó —, más los handoffs, las preguntas abiertas, el plan y las ramas que cortó el Build. |
| Expertos | Los niveles de competencia **recalculados desde la evidencia al momento de leer**, nunca el número guardado en disco, con la evidencia detrás de cada uno. |
| Watchers | Todavía no: las tarjetas de vigilancia las escribe la fase Watch y el modelo no las lee, así que la pestaña lo dice en vez de inventarse una tarjeta. Usa `tldrx watch list`. |
| Cómo se usa | El loop de la terminal, como comandos para copiar y pegar. |

Cuatro estados levantan una alerta, porque cada uno es un run esperando a una **persona**:
una pregunta abierta, una compuerta pendiente, una etapa que falló, y un paquete
`--prepare` esperando a que alguien lo corra y lo mande con `--commit`. `ready` y `done` son
estados del trabajo, no peticiones.

## El dinero que muestra es dinero medido

Un run manejado por una sesión anfitriona (`tldrx run attend host`) no gasta dólares
medidos: sus turnos se le cobran a esa sesión. Un run así se lee como `$0.00` contra su
techo, y eso es cierto sobre lo que tldrx midió y falso sobre lo que costó el run. Por eso
la página imprime la otra moneda a un lado: los tokens de anfitrión declarados con
`--tokens`, y cuántos turnos nadie costeó. Las dos nunca se suman — no hay tipo de cambio.

::: info No lee `events.jsonl`
Todo lo que vive únicamente en el ledger no está en esta página: las notas de operador
(`tldrx note`), los costos por intento, las stories reabiertas, los reintentos de revisión.
`tldrx replay <run>` y `tldrx run status` sí leen el ledger.
:::

## No puede contradecir a la CLI

"Qué está esperando este run" se deriva **una sola vez**, en `src/core/run/waiting.ts`, y
tanto `tldrx run status` como esta página llaman a lo mismo. Antes contestaban por separado,
y un run recién creado aquí se dibujaba como "esperando en una compuerta" mientras la CLI lo
llamaba `ready`: en un run que nadie ha empezado, la compuerta de cada etapa dice `pending`,
porque ese es el valor con el que nace el campo.

## Para quien diseñe

La página son dos archivos y una costura: algo lee el workspace y lo convierte en un
documento JSON plano, y otra cosa lo dibuja. Pídele `GET /model.json` al servidor y ya
tienes todo — sin build, sin framework, sin markup que descifrar. La forma está documentada
en
[the dashboard model](https://github.com/ederwii/tldr-experts/blob/main/docs/dashboard-model.md),
y `modelVersion` sube solo cuando un campo **se quita o cambia de significado**; agregar uno
nunca lo sube.
