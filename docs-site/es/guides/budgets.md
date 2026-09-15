---
title: Presupuestos y estimaciones
---

# Presupuestos y estimaciones

Cómo evitar que un run cueste más de lo que querías, en el orden en que los cuatro frenos
actúan de verdad. Solo los dos primeros actúan *antes* del dinero.

## 1. Mira la cuenta antes de pagarla

```bash
tldrx next --prepare        # o --dry-run: ninguno lanza nada ni cuesta nada
```

Los dos imprimen la **contabilidad del contexto**: el prompt ya armado, desglosado según de
dónde salieron los bytes:

```
context 83.7 KB of 400.0 KB (~23.8k tok, 12% of sonnet's ~200.0k window)
  stage 3.7 KB · inputs 77.3 KB · experts 2.7 KB (bodies 2.5 KB, knowledge 250 B)
  input docs/domain-design/DECISIONS-NEEDED.md 15.1 KB
  input docs/domain-design/SEED-README.md 7.6 KB
```

Si se pasa del `prompt_max_bytes` de la etapa (400 KB por omisión), la etapa se **rechaza**
— salida `2`, antes de lanzar nada — nombrando las secciones más grandes y el ajuste que
encoge cada una. `--prompt-max-bytes <n>` lo sobreescribe para un solo run.

Esa contabilidad es la razón de que exista el techo. En un run real el mismo prompt medía
159,575 bytes antes de que el presupuesto de bytes se volviera un único total compartido:
el 52% era conocimiento de expertos que nadie había pedido, y uno de los seis documentos
que el run existía para resolver se había tirado completo para hacer espacio. Hoy mide
85,676 bytes, y trae ese documento entero.

## 2. Compra menos pensamiento

```bash
tldrx next --effort low        # low | medium | high | xhigh | max
```

`--effort` es la palanca que cambia lo que un turno *cuesta*, en vez de detener uno que ya
salió caro. Los valores por omisión de cada etapa están puestos para esto: What `medium`,
How `high`, Plan `medium`, Build `high`, Watch `low`. Las etapas baratas corren baratas, y
solo las que de verdad razonan pagan por `high`.

## 3. Que el agente no se ponga a leer para siempre

```bash
tldrx next --max-reads 60
```

Este es el freno de verdad. Cuenta las llamadas `Read` / `Glob` / `Grep` completadas
directo del stream que el modelo ya está mandando — sin llamadas extra, sin tokens extra —
y detiene el run al llegar al techo. Por omisión: **120** para What/How/Plan, **200** para
Build, **60** para Watch. El intento registra `stopped_by: max_reads`, y la vista en vivo
muestra `reads 37/120`.

## 4. `--max-usd` es el más débil

```bash
tldrx next --max-usd 3
```

Termina un run **después** del turno en el que ya va. No puede detener un turno en vuelo,
porque el costo apenas se conoce cuando el turno lo reporta. Medido: a una llamada se le
pasó un techo de $1.50 y se mató con `error_max_budget_usd` después de
`total_cost_usd: 5.15`, en un solo turno de 597 segundos.

**Dimensiona el prompt para el dinero que estás dispuesto a perder, no para el techo que
pasaste.**

## Mover un techo

```bash
tldrx budget show
tldrx budget raise 04-build 25 --take-from 02-how --note "the plan grew to nine stories"
```

Una fase que se cobra en tokens de sesión host tiene su propio techo — `ceiling_host_tokens`
en `budget.yml`, que nunca se mezcla con `ceiling_usd`; ver
[Presupuestos](/es/concepts/budgets).

`raise` recibe un **delta**, no un techo nuevo: `raise 04-build 5` convierte $20 en $25.
`--take-from` lo saca de otra fase en lugar de subir el total del run. El log de eventos
guarda quién lo subió, por cuánto y por qué. Subir un techo a media etapa es además una de
las cosas que impide que una [compuerta agent](/es/concepts/gates) se firme sola.

### Dinero que una fase terminada ya no puede gastar

Una fase que terminó por debajo de su techo se queda con la diferencia, y ninguna etapa la va a
gastar nunca. Cuando una fase posterior se rechaza por dinero, el rechazo ahora lo dice y nombra
el movimiento:

```
budget: finished phase(s) hold $16.25 unspent (01-what $16.25), which covers the $11.07 shortfall:
`tldrx budget raise 04-build 11.07 --run <id> --take-from 01-what`, or launch
`tldrx run auto --rebalance-finished` to make that move on the record automatically.
```

`tldrx run auto` hace exactamente ese movimiento antes de rechazar, y sigue. Viene **encendido
por defecto** (gh #330): `--no-rebalance-finished` lo apaga para un lanzamiento cuyos techos de
fase deben significar exactamente lo que se fijó, y `--rebalance-finished` se sigue aceptando.
Salió apagado, porque un techo de fase es una decisión de una persona sobre dinero; se encendió
después de que una auditoría de runs desatendidos encontrara 22 intervenciones humanas por el
tamaño de las fases cuyas notas de aumento, según la lectura de la auditoría, nunca cambiaron el
trabajo. `tldrx next` por sí solo nunca hace el movimiento, y cuando ese movimiento financiaría un
lanzamiento, el hook `budget-gate` deja arrancar `run auto` en vez de rechazarlo antes (gh #321).
"Terminada" es estricto — todas las etapas de la fase
en `done` o `skipped`, ninguna stale, cobrada en `metered-usd` y sin turnos no medidos (cuyo gasto
solo sería una cota inferior). Una fase con una etapa todavía por correr, como `05-watch` mientras
Build está bloqueado, nunca aporta. Mueve solo el faltante, nunca sube el techo del run, nunca
rebasa una autorización registrada, y deja un `budget.raised` por fase donante con
`source: run auto --rebalance-finished` y tu nombre. Si todas las fases terminadas juntas no cubren
el faltante, no se mueve nada y el rechazo dice cuánto falta todavía.

### Una fase que no puede pagar su propio reintento

Una fase cuyo techo equivale a **un** intento de su etapa rechaza todo reintento después del
primer centavo gastado —por aritmética, no por política. `tldrx run new` dimensiona cada fase
en `attempts ×` su etapa desde gh #170, así que ya no puede crear una; un run creado antes la
arrastra de por vida, y el dinero de una fase dimensionada así se gasta antes de que alguien se
entere. La columna `next` ahora lo dice primero (gh #232):

```
  phase       ceiling      spent       left  next stage       est.  next
> 04-build    $787.87      $1.43    $786.44  build          $71.00  NO-RETRY
  05-watch    $175.08      $0.00    $175.08  watch         $175.08  NO-RETRY

NO-RETRY: phase 05-watch holds one attempt of `watch` ($175.08) and that stage declares
attempts: 2, so it must hold $350.16. The first failed attempt spends money the retry cannot
then find, and a run that cannot retry stops where nothing unattended can restart it. Size it
now:
  tldrx budget raise 05-watch 175.08 --run <id>
```

El veredicto se mide contra el `budget_usd` **declarado** de la etapa y su propio `attempts:`,
nunca contra la columna `est.` de al lado. En un run cuyos turnos están parcialmente sin medir
la estimación queda corta, así que `ceiling / est.` reporta un margen que no existe: mientras
menos medido está un run, más seguro lo declara esa razón. Una declaración no se mueve con la
medición. `attempts: 1` es una decisión de que la etapa no tiene reintento, así que un techo
que sostiene exactamente uno es el tamaño correcto para ella y dice `ok`. Una fase sin etapas
por correr dice `n/e`: no hay nada que dimensionar, y callar no es lo mismo que decir que está
bien.

Es una advertencia, nunca un rechazo: `tldrx next` sigue corriendo, y la línea de "todo en
orden" dice cuántas fases la arrastran.

Y si no estabas leyendo `budget show` en el momento que importaba, la muerte de la etapa
también lo dice. La última línea de una etapa fallida era siempre el mismo literal —*"cost is
recorded, not refunded — retry with `tldrx next`"*— que en una fase sin margen nombra justo el
comando que vuelve de inmediato como exit 2. Ahora nombra el rechazo:

```
01-what/what failed: the sub-agent failed
cost is recorded, not refunded — and `tldrx next` would be refused on arrival (exit 2, the
money family): phase 01-what has $2.58 left and the retry is priced at $3.00, $0.42 short.
Run `tldrx budget raise 01-what 0.42 --run <id>` first, or `tldrx reject --note "…"`.
```

Esa predicción se hace con las dos cifras propias del gate —lo que le queda a la fase y la misma
estimación de trabajo restante contra la que el freno la compara—, así que el consejo y el
rechazo que habrías encontrado no pueden contradecirse. Donde este gate no decide el reintento
(`on_exceed: warn`, una fase en `host-tokens`, un run `attended_by: host`) se imprime la línea
de siempre sin cambios: eso es "no le toca a este gate", que no es lo mismo que "alcanza".

## Las tres perillas, y cuál limita a un sub-agente

Un `raise` como el de arriba mueve el **techo de la fase**, y un techo de fase decide una sola
cosa: si la siguiente etapa puede arrancar. No limita a ningún sub-agente. El techo bajo el que
realmente se despacha a un developer o a un reviewer sale del **`budget_usd` de la etapa** en
`run.yml`, y `per_agent_max_usd` solo lo recorta por arriba. Medido en dos runs desatendidos
reales: subir solo la cifra de la etapa, 16.20 → 60, movió el techo de un developer de 5.97 a
22.11 en el siguiente spawn, mientras que subir las otras dos sin tocarla no movió nada.

```bash
tldrx budget raise 04-build 25 --stage build
```

`--stage` suma el mismo monto al `budget_usd` de esa etapa, y es lo que hay que usar cuando un
sub-agente murió contra su tope — no cuando al run se le acabó el dinero. Un `raise` que no
nombra etapa lo dice en su propia salida: no se movió ningún techo de spawn.

El `budget_usd` de la etapa es también aquello a lo que se **escalan** los precios del plan. El
tope de una story es `max(price × scale × 3, $4.00)`, y `scale` vale 1 solo mientras los precios
de `03-plan/budget.yml` suman dentro de la etapa: una etapa de $16.20 sobre un plan de $114.00 es
una escala de 0.1421, así que una story valuada en $14.00 queda topada en $5.97, no en $42 — y
subir todos los precios no mueve nada, porque una subida uniforme conserva la proporción y la
suma. El detalle de la compuerta `plan` y el stderr del Build al entrar lo dicen, con el factor
y el comando `--stage` que lleva la escala a 1; un developer que muere contra su tope recibe la
fórmula con sus entradas y la misma perilla nombrada.

El reviewer es el único turno que el framework no va a financiar a medias: cuando lo que le
queda a la etapa está por debajo de lo que cuesta una revisión, no se lanza reviewer alguno.
La historia queda con su diff mergeado y su revisión pendiente, no se gasta nada en un turno
que no podía leer el diff, y el registro dice *no corrió ningún reviewer* — nunca que pidió
cambios ni que falló. La línea que imprime trae el comando `--stage` con el monto que falta.

## Dejar por escrito lo autorizado

```bash
tldrx budget grant 20 --fact F031
tldrx budget grant 5 --fact F031 --phase 04-build --on-exceed block
```

`grant` registra lo que el dueño autorizó, para que el techo tenga a qué responderle. No gasta
nada y no mueve ningún techo: el `<usd>` es un **total**, al revés del delta que recibe `raise`.
`--fact` es obligatoria y tiene que nombrar un hecho vivo, porque una autorización que no puede
citar una decisión es un número que nadie dijo. `budget show` la vuelve a leer en una línea —el
hecho, cada alcance y la política— y no dice nada cuando no hay ninguna, porque imprimir
`$0.00 authorized` sería inventar justo la cifra que esa llave se niega a adivinar.

Después, `raise` revisa contra ella el techo que está por escribir, antes de que se escriba
nada. Con el valor por omisión lo escribe y avisa; con `--on-exceed block` lo rechaza y deja
`budget.yml` idéntico byte por byte. Esa política es `on_grant_exceed`, y **no** es `on_exceed`:
una gobierna gastar por encima de un techo y la otra escribir uno por encima de lo autorizado.
Ver [Presupuestos](/es/concepts/budgets).

## Después

```bash
tldrx cost                # por intento, por etapa, por run
tldrx cost --all          # todos los runs del workspace
tldrx run estimate        # el único comando que adivina
```

`cost` lee lo que de verdad se cobró, por intento: los reintentos nunca se doblan dentro
del total de la etapa, ya que el reintento suele ser justo el dinero que andabas buscando.
Las dos economías se reportan por separado y nunca se suman; ver
[Presupuestos](/es/concepts/budgets).

```bash
tldrx cost --stories      # por story, contra el techo de spawn que le dieron
```

`--stories` es el reporte de calibración: una fila por story de build, con lo que costó de
forma medible, el techo de spawn que le entregó el ejecutor y la razón entre ambos. No cambia
ningún techo y no gasta nada. Úsalo antes de argumentar que el valor por omisión de una etapa
está mal: las cifras que vienen de fábrica dicen en sus propios comentarios que son suposiciones,
y este es el comando que produce la evidencia con la cual reemplazarlas.

`run estimate` imprime `ESTIMATE` con todas sus letras. Su mitad de entrada está medida (el
prompt real); su mitad de salida es la mediana de los intentos pasados en esa etapa, y sin
historia no imprime nada en lugar de inventarse un número.

## Números gruesos

Medidos con Sonnet, agosto de 2026, en un workspace real — indicativos, no una lista de
precios.

Los techos que vienen de fábrica son afirmaciones del mismo tipo, y lo dicen: cada `budget_usd`
de un archivo de etapa y cada `default_budget_usd` de un archivo de workflow lleva un comentario
`[assumption]` sobre el dinero mismo, que nombra qué es (una suposición acotada), qué evidencia
existe (una story que costó 5.8 veces el techo que le dieron a su spawn) y qué la reemplazaría
(`tldrx cost --stories`). Un run creado por `tldrx seed apply` registra lo mismo en su propio
`run.yml`, como `triage.budget_basis: model-guess`.

- una etapa What: **$1.20–1.40**
- un entrenamiento ligero de experto sobre unos 20 archivos: **≈ $5**
- el piso de cualquier llamada fría a `claude -p`: **≈ $0.25**, porque se pagan entre 10 y
  26 mil tokens de creación de caché antes de la primera respuesta. Las etapas rechazan un
  techo por debajo de eso en vez de pagar por una falla garantizada.

El detalle completo: [6 — Budgets and cost](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/06-budgets-and-cost.md).
