---
title: Dashboard
---

# Dashboard

Hay una [demo en vivo de esta página](/es/demo) en este sitio, generada con datos
sintéticos en cada despliegue.

`tldrx dashboard` dibuja el workspace como una sola página web. Es de **solo lectura**: no
hay un botón ahí que cambie un archivo, porque un dashboard que puede lanzar trabajo es una
segunda fuente de verdad compitiendo con los archivos.

```bash
tldrx dashboard              # un servidor vivo en 127.0.0.1, que se redibuja al cambiar los archivos
tldrx dashboard --static     # escribe un index.html autocontenido y se detiene
tldrx dashboard --static --out ./somewhere/   # --out nombra un directorio, no un archivo
```

El servidor vivo vigila el workspace y manda un reload cuando cambia algo debajo de él. La
exportación estática es un solo archivo con el CSS, el JavaScript y los datos incrustados —
ninguna referencia de red, de ningún tipo —, así que se ve igualito sin internet y no filtra
nada sobre quién la abrió. `--out` nombra el directorio donde escribirla, y se crea si no
existe; la página que queda adentro siempre se llama `index.html`. Los dos son el mismo
documento; lo único que cambia es si vigila.

## Qué muestra

| Vista | Qué trae |
|---|---|
| Runs | Primero la **tira Now** — una tarjeta por run vivo, con sus puntos de fase, la petición, el gasto y cuánto lleva callado — y luego cada run como fila: estado, avance por fase, gasto, y **qué está esperando**. El que puedes retomar ahora mismo lleva `← next`, la misma marca que imprime `tldrx status`. |
| Waves | El plan como barras: una fila por ola, una barra por story dentro de ella, para que el paralelismo y las rondas de arreglo se vean de un vistazo. **No hay eje de tiempo**: el modelo no trae inicio ni fin por story, y uno inventado se leería como medido. |
| One run | La **línea de tiempo por fase** — un carril por fase, y cada etapa se abre a su costo, su compuerta y quién la firmó (el mismo camino sigue ahí como tabla, a un clic) —, la **rejilla de stories**, una celda de estado por story que se abre a lo que dicen el archivo del plan y el ledger, y el **flujo de eventos**, cada hecho con fecha que trae el modelo en un solo orden, filtrable por tipo. Más el camino de ejecución etapa por etapa — experto, modelo, costo, compuerta, quién la firma y quién la firmó —, más los handoffs, las preguntas abiertas, el plan y las ramas que cortó el Build. Del ledger: las **notas de operador** que alguien dejó con `tldrx note`, el intento en el que va cada story y los reintentos de revisión gratuitos que se le concedieron, las reaperturas y sus motivos, y cada vez que el freno del presupuesto se negó a arrancar una etapa. De `budget.yml`: los techos por fase, las palancas y el **cupo de tokens de anfitrión**. De `04-build/preflight.yml`: las **compuertas base** — qué hizo cada comando de gate del workspace sobre el árbol intacto, para que un Build que se negó a arrancar no parezca una etapa que retrocedió sin motivo. Y, cuando están puestos, por qué se **canceló** un run (quién, cuándo, la nota) y si sus **worktrees** de épica se conservan. |
| Experts | Los niveles de competencia **recalculados desde la evidencia al momento de leer**, nunca el número guardado en disco, con la evidencia detrás de cada uno. |
| Watchers | Una tarjeta por feature entregada, leída de `05-watch/watchers/*.md`: qué señal vigilar, quién la cuida, la épica y las stories detrás, y — en una `draft` — las citas `absent:` que dicen exactamente qué todavía no está instrumentado. La página **lee** las tarjetas; no las vuelve a checar contra el código de hoy. Eso es `tldrx watch check`. |
| How to use | El loop de la terminal, como comandos para copiar y pegar. |

Cuatro estados levantan una alerta, porque cada uno es un run esperando a una **persona**:
una pregunta abierta, una compuerta pendiente, una etapa que falló, y un paquete
`--prepare` esperando a que alguien lo corra y lo mande con `--commit`. `ready` y `done` son
estados del trabajo, no peticiones.

Nada más levanta una, y eso es una regla, no un olvido. Una tarjeta `draft`, una compuerta
base en rojo y un rechazo de presupuesto pasado se dibujan como paneles: cada uno sigue
siendo cierto mientras nadie lo arregle, y ninguno es un run que te esté esperando ahorita.
Una alerta que significa "alguien debería ver esto algún día" es una alerta que la gente
deja de leer.

## La tira Now responde tres preguntas

¿Está esperando a una **persona** ahorita?, ¿hay algo **roto o callado**?, y ¿cuánto ha
**costado**? Una tarjeta por run vivo — vivo quiere decir todo run que no esté `done` ni
`cancelled`, así que un run que nadie ha arrancado y uno que nada puede mover están los
dos ahí. Las tarjetas que piden algo se van al frente.

Tres de sus decisiones vale la pena conocerlas, porque cada una pudo haber sido al revés:

- **Una cota inferior nunca lleva barra.** Una barra de progreso es una afirmación sobre un
  denominador, y solo es honesta cuando el número encima es todo lo que se gastó. Cuando
  `spend.basis` es cualquier cosa menos `measured` — cuando hubo turnos que no metieron
  nada al medidor — la tarjeta muestra la cifra medida con una marca de **lower bound** y
  *sin barra*, más cuántos de cuántos turnos no costaron nada. La frase completa, la del
  propio modelo, va en el tooltip de la marca y en el detalle del run.
- **"Callado" son 30 minutos, y esa línea es de la página, no del modelo.** El modelo
  reporta `ageSeconds` y a propósito no trae umbral. Media hora sin nada en el ledger es o
  una persona a la que nadie le ha preguntado o un proceso que se murió. Una lectura de
  `mtime` dice **touched** y no "last event" — el archivo se escribió, que no es lo mismo
  que el run haberse movido —, y un ledger fechado *después* de la lectura se nombra como
  dos relojes que no coinciden en vez de convertirse en frescura.
- **Los puntos son las fases que declara el propio `run.yml`.** `run new` escribe el
  workflow completo de entrada, así que un run `feature` sí dibuja cinco, what → watch. Un
  workflow que declara tres dibuja tres. Nada se rellena para que cuadre la forma.

## Teclado

Todo es un link, un botón o un `<details>`, así que Tab y Enter funcionan solos. Encima de
eso: <kbd>j</kbd> / <kbd>k</kbd> se mueven entre tarjetas y filas, <kbd>enter</kbd> abre la
que tiene el foco, y <kbd>/</kbd> salta a los filtros. Están impresos debajo de la fila de
filtros — un atajo que nadie descubre no es una función.

Los runs con notas de operador llevan una ✎ chiquita en la lista, con la cuenta en el
tooltip — las notas siguen viviendo en el detalle del run. Es a propósito la marca más
chica que es cierta, y es provisional: la lista es una lista, y meterle un contador a un
renglón es una decisión de diseño que nadie ha tomado todavía.

## El dinero que muestra es dinero medido

Un run manejado por una sesión anfitriona (`tldrx run attend host`) no gasta dólares
medidos: sus turnos se le cobran a esa sesión. Un run así se lee como `$0.00` contra su
techo, y eso es cierto sobre lo que tldrx midió y falso sobre lo que costó el run. Por eso
la página imprime la otra moneda a un lado: los tokens de anfitrión declarados con
`--tokens`, y cuántos turnos nadie costeó. Las dos nunca se suman — no hay tipo de cambio.

Y cuando `budget.yml` cotiza el run en `host-tokens`, la página deja de citarle dólares por
completo — igual en la lista de runs que en el detalle. Ahí `ceiling_usd` no gobierna nada,
así que `$0.00 of $25.00`, en barra o en palabras, sería una afirmación segura sobre un
denominador que no aplica. El gasto se lee en tokens, contra `ceiling_host_tokens` — el
techo contra el que esos tokens sí se miden, que vive en `budget.yml` y en ningún otro
archivo.

::: info Lo que sigue estando solo en `tldrx replay`
La página lee el ledger, pero no entero: la narrativa — los costos por intento, los agentes
que se lanzaron, los checks, el orden en que pasaron las cosas — es trabajo de
`tldrx replay <run>`.
:::

::: info La página lee. No checa.
Cada archivo que abre, lo abre de solo lectura, y no vuelve a derivar nada que los archivos
ya deciden. La tarjeta de vigilancia es el caso más claro: `tldrx watch check` comprueba que
cada `[src: …]` de una tarjeta siga apuntando a código real, y el dashboard no — imprime el
`status` que trae la tarjeta y las fuentes `absent:` que ella misma cita, uno al lado del
otro. Un sello `verified` encima de una señal `absent:` se muestra tal cual, como un sello
viejo, en vez de que una tercera opinión lo corrija en silencio.
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
