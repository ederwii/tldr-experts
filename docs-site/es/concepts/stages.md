---
title: Las cinco etapas
---

# Las cinco etapas

Una pieza de trabajo pasa por cinco etapas, en orden: **What → How → Plan → Build →
Watch**. Cada una es una vuelta del mismo ciclo pequeño.

> **Investigate** — leer código, documentación y memoria; cada hallazgo trae su fuente.
> **Handoff** — escribir un archivo markdown: qué se encontró, qué se decidió, qué sigue sin saberse.
> **Interview** — convertir en preguntas para ti solo lo que de verdad no se sabe.
> **Gate** — alto. Nada de lo que sigue corre hasta que la compuerta esté firmada.

Avanzas de una etapa a la vez con `tldrx next`. Nada es implícito: lo que produce cada
etapa son archivos en disco, y la etapa siguiente los lee.

## Qué hace cada etapa

| Etapa | Qué responde | Qué escribe |
|---|---|---|
| **What** | ¿Qué vamos a hacer, y qué estamos dejando fuera a propósito? | `intent.md`, `scope.md`, `success-metrics.md`, `open-questions.md`, `handoff.md` |
| **How** | ¿Cómo encaja en este código — componentes, contratos, riesgos, pruebas? | `design.md`, `contracts.md`, `risks.md`, `test-strategy.md`, `handoff.md` |
| **Plan** | ¿Cuáles son las piezas, y en qué orden? | `epics/`, `stories/`, `waves.yml`, `handoff.md` |
| **Build** | El código. | una rama y un commit por story, más `04-build/handoff.md` |
| **Watch** | ¿Qué se puede romper en producción, y cómo nos enteraríamos? | una tarjeta de vigilancia por cada cosa entregada |

**How** es la etapa que más piensa: corre en un modelo más grande y con más esfuerzo,
porque cada componente que nombra tiene que caer en una ruta real de tu repo. **What** y
**Plan** son más baratas a propósito.

**Build** es la que no se parece a las demás. Corta una rama de épica y luego, por cada
story: un worktree y una rama propios, un subagente que escribe el código, una nueva
corrida del DoD (*definition of done*) de esa story, un commit, un merge a la épica — y
después un revisor aparte, de solo lectura, cuyo trabajo es no estar de acuerdo. La rama de
la épica te espera a ti; el framework nunca hace push.

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

El detalle completo: [the loop](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/02-the-loop.md)
en el repo.
