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
context 83.7 KB of 160.0 KB (~23.8k tok, 12% of sonnet's ~200.0k window)
  stage 3.7 KB · inputs 77.3 KB · experts 2.7 KB (bodies 2.5 KB, knowledge 250 B)
  input docs/domain-design/DECISIONS-NEEDED.md 15.1 KB
  input docs/domain-design/SEED-README.md 7.6 KB
```

Si se pasa del `prompt_max_bytes` de la etapa (160 KB por omisión), la etapa se **rechaza**
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

`run estimate` imprime `ESTIMATE` con todas sus letras. Su mitad de entrada está medida (el
prompt real); su mitad de salida es la mediana de los intentos pasados en esa etapa, y sin
historia no imprime nada en lugar de inventarse un número.

## Números gruesos

Medidos con Sonnet, agosto de 2026, en un workspace real — indicativos, no una lista de
precios.

- una etapa What: **$1.20–1.40**
- un entrenamiento ligero de experto sobre unos 20 archivos: **≈ $5**
- el piso de cualquier llamada fría a `claude -p`: **≈ $0.25**, porque se pagan entre 10 y
  26 mil tokens de creación de caché antes de la primera respuesta. Las etapas rechazan un
  techo por debajo de eso en vez de pagar por una falla garantizada.

El detalle completo: [6 — Budgets and cost](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/06-budgets-and-cost.md).
