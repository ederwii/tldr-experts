---
title: Las cinco etapas
---

# Las cinco etapas

Una pieza de trabajo pasa por cinco etapas, en orden: **What → How → Plan → Build →
Watch**. Cada una es una vuelta del mismo ciclo — Investigate, Handoff, Interview, Gate.

> **Investigate** — leer código, documentación y memoria; cada hallazgo trae su fuente.
> **Handoff** — escribir un archivo markdown: qué se encontró, qué se decidió, qué sigue sin saberse.
> **Interview** — convertir en preguntas para ti solo lo que de verdad no se sabe.
> **Gate** — alto. Nada de lo que sigue corre hasta que la compuerta esté firmada.

Avanzas de una etapa a la vez con `tldrx next`. Nada es implícito: lo que produce cada
etapa son archivos en disco, y la etapa siguiente los lee.

## Qué hace cada etapa

| Etapa | Qué responde | Qué escribe |
|---|---|---|
| **What** | ¿Qué vamos a hacer, y qué estamos dejando fuera a propósito? | `intent.md`, `scope.md`, `success-metrics.md`, `open-questions.md`, `handoff.md`, `questions.md` |
| **How** | ¿Cómo encaja en este código — componentes, contratos, riesgos, pruebas? | `design.md`, `contracts.md`, `risks.md`, `test-strategy.md`, `handoff.md`, `questions.md` |
| **Plan** | ¿Cuáles son las piezas, y en qué orden? | `epics/`, `stories/`, `waves.yml`, `budget.yml`, `handoff.md`, `questions.md` |
| **Build** | El código. | una rama y un commit por story, más `04-build/handoff.md` |
| **Watch** | ¿Qué se puede romper en producción, y cómo nos enteraríamos? | una tarjeta de vigilancia por cada cosa entregada |

**Watch** puede volver con las manos vacías: cuando el código que vigila no emite ninguna línea
de log, ninguna métrica y ningún span, su tarjeta escribe `Query: none — <razón> [src: …]` y todas
las vistas lo muestran como `unobservable — <razón>` — una ausencia con fuente, no una consulta que
nadie puede correr.

**How** es la etapa que más piensa: corre en un modelo más grande y con más esfuerzo,
porque cada componente que nombra tiene que caer en una ruta real de tu repo. **What** y
**Plan** son más baratas a propósito.

**Build** es la que no se parece a las demás. Corta una rama de épica y luego, por cada
story: un worktree y una rama propios, un subagente que escribe el código, una nueva
corrida del DoD (*definition of done*) de esa story, un commit, un merge a la épica — y
después un revisor aparte, de solo lectura, cuyo trabajo es no estar de acuerdo. La rama de
la épica te espera a ti; el framework nunca hace push.

Las stories de una misma ola son independientes por construcción — el plan deja cada
`depends_on` en una ola **anterior** —, así que Build corre **dos a la vez por omisión** y
las mergea a la épica en el orden en que el plan las lista, terminen como terminen. `tldrx
next --parallel N` (y `tldrx run auto --parallel N`) lo cambia para un run; `parallel: N` en
tu propio `.tldrx/stages/build/stage.yml`, o `build: {parallel: N}` en un workflow, lo
cambia de forma permanente. Dos y no más porque un abanico más ancho es lo primero que
sufre una laptop.

Una rama por épica da por hecho que las épicas son independientes. Cuando una story lleva
`depends_on` a una story de **otra** épica, las épicas forman una cadena y el run corta una
sola **rama de integración**, `epic/<run-id>`, y las épicas se quedan en el plan como
etiquetas. Eso se decide en Plan, a partir de lo que el plan ya dice: la verificación `plan`
imprime qué modelo leyó — `epics form a chain (E3→E2, E4→E2) → single integration branch` o
`independent epics → one branch each` —, así que nunca te enteras a medio Build.

## El scope decide qué etapas corren

`tldrx run new <slug> --scope <scope>` elige un preset. Hay 13 en disco, y el preset dice
qué etapas corren, con cuánta profundidad, con qué presupuesto por omisión y quién firma
cada compuerta.

```bash
tldrx run new bulk-pricing --scope feature   # what, how, plan, build, watch — $25 por omisión
tldrx run new is-redis-enough --scope spike  # solo what y how — $6 por omisión, memo de decisión
```

Una etapa que el scope se salta queda registrada como saltada, no desaparece en silencio:
`skips: [plan, build, watch]` está escrito en el archivo del preset, así que la omisión es
una decisión que puedes leer. La lista completa: `bugfix` `docs` `feature` `hotfix`
`integration` `migration` `performance` `prototype` `refactor` `retro` `security-patch`
`spike` `upgrade`.

Algunos scopes llegan a Build sin pasar por Plan — `docs`, `hotfix`, `performance`,
`prototype`, `security-patch`. Entonces Build escribe la única story que esa decisión
implica, a partir de tu handoff de What y de tus respuestas, y `tldrx run status` dice
`plan: implicit (scope skips Plan)` para que siempre lo puedas distinguir de un plan que
leíste y aprobaste.

## Dónde viven las definiciones

Las etapas son archivos, no código. `stages/<name>/stage.yml` es el contrato: qué modelo,
cuánto puede gastar, qué puede leer, qué tiene que escribir y qué verificaciones corren al
final. `stages/<name>/stage.md` es la plantilla de handoff que se le entrega al subagente.
`workflows/<scope>.yml` declara el orden. Un `.tldrx/stages/` o un `.tldrx/workflows/` en
tu propio proyecto le ganan a los que vienen incluidos.

## El revisor puede correr en otro modelo

`model:` y `effort:` en un archivo de etapa fijan la etapa entera, así que el desarrollador
de Build y el revisor que juzga su diff siempre corrieron con esos dos mismos valores. Dos
claves opcionales permiten que el revisor sea distinto:

```yaml
reviewer: {model: opus, effort: high}      # el revisor de esta etapa, sea cual sea la story
reviewer_by_stakes:                        # ...salvo que la STORY diga qué arriesga
  security: {model: opus, effort: high}
```

`reviewer_by_stakes:` se indexa por el campo opcional `stakes:` de una story — uno de
`security`, `money`, `data`, `correctness`, `routine` —, que escribe el agente de Plan y que
nunca se infiere de la prosa. Una story que no lo declara jamás lee el mapa. `tldrx next
--model`/`--effort` siguen ganándoles a ambas: una bandera explícita es tu palabra para esa
invocación.

Las dos claves vienen ausentes y `reviewer_by_stakes:` viene vacío, a propósito. Nada aquí
midió todavía que un revisor más fuerte encuentre más — eso es justamente lo que estas
claves vuelven contestable, y ahora cada veredicto registra el modelo que lo produjo, así
que `tldrx replay` muestra `review approve for story S1 by opus · effort high (spawned)` en
vez de dejarte adivinar qué modelo firmó.

El detalle completo: [the loop](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/02-the-loop.md)
en el repo.
