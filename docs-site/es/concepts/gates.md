---
title: Compuertas y quién las cierra
---

# Compuertas y quién las cierra

Cada etapa termina en una compuerta (*gate*). Una compuerta es un alto: nada de lo que
sigue corre hasta que se cierre. Esa parte nunca cambia. Lo que eliges por etapa es **quién
tiene permiso de cerrarla**.

Hay tres políticas.

## `human` — la firmas tú

La etapa termina, `tldrx next` sale con `4` (*esperando a una persona*) y el run se queda
esperando.

```bash
tldrx approve --note "why this is right"
tldrx reject  --note "contracts.md does not name the events"
```

`approve` no es un sello de goma. **Vuelve a correr las verificaciones de la etapa contra
lo que hay en disco en ese momento**: validación de esquema, el verificador de fuentes y
cualquier comando de shell que tu `workspace.yml` haya declarado, corrido de verdad. Si
alguna falla, sale con `2` y te dice cuál. Solo entonces registra quién firmó, cuándo y tu
nota tal cual en `run.yml`, y adelanta el cursor.

`reject --note` regresa la etapa a `ready`. Tu nota no se va al archivero: el siguiente
intento la recibe, junto con la falla anterior, bajo `## Previous attempt` en su prompt, y
los archivos que ya había escrito se le incluyen completos, para que el intento 2 edite en
lugar de empezar de cero.

## `auto` — la herramienta la puede cerrar, si muestra en qué se basó

Una compuerta `auto` no es una compuerta saltada. Solo la cierra cuando se cumplen
**siete** cosas a la vez, y de todos modos imprime las siete:

```
auto-gate: checks=claim-sources:passed,no-reask:skipped,budget-gate:skipped; questions=0 open;
budget=$0.44 of $6.00 stage, phase 02-how $0.44 of $6.00; status=awaiting_gate;
claim-sources=passed; stories=n/a (not a build stage); boundary=n/a (not a build stage)
```

1. las verificaciones propias de la etapa pasaron;
2. su fase no tiene ninguna pregunta abierta;
3. el gasto está dentro del techo de la etapa;
4. el gasto está dentro del techo de la fase;
5. la etapa no falló;
6. cada afirmación que escribió resolvió contra una fuente real ([evidencia](/es/concepts/evidence));
7. solo en una etapa Build — cada story llegó a `done`, **y** la rama de la épica no cambió
   nada que el run nunca declaró que iba a tocar.

Que falle cualquiera de ellas la regresa a la compuerta humana, diciendo cuál falló y qué
midió. Una cita que nadie pudo comprobar no reprueba la etapa, pero sí detiene una
compuerta auto: esa es justo la línea que una persona debería mirar.

## `agent` — un agente puede firmar, sobre evidencia escrita

La política más fuerte, y nunca llega por omisión. Esas mismas siete condiciones, más que
no se haya tomado ninguna decisión de presupuesto mientras la etapa corría, más una **nota
de evidencia firmada**: una lista de verificación donde cada punto trae una fuente que
resuelve, validada por la misma maquinaria que revisa lo que la etapa escribió.

```bash
tldrx gate template          # escribe el esqueleto de la nota, para llenarlo
tldrx approve --as-agent     # la valida, y entonces firma
```

Se cae hacia una persona si hay una pregunta abierta, si se movió un techo, si hubo trabajo
fuera del límite declarado, o si el propio agente se niega a firmar. Una persona siempre
puede aprobar una etapa con compuerta `agent` sin ninguna bandera — esa intervención queda
registrada como persona, y ese es justo el punto de la separación: una compuerta `agent` es
una que un agente *puede* cerrar, nunca una que tú no puedas.

## Cómo elegir la política

Cada scope trae sus valores por omisión, y todos conservan al menos una compuerta humana.
`feature` es `what: human, how: auto, plan: human, build: auto, watch: human`.

```bash
tldrx run new pay --gates what,plan,build           # la lista SON las compuertas humanas
tldrx run new pay --gates plan:agent,build:agent    # calificadas: nombra la política de frente
tldrx run new pay --gates all                       # o bien: none
```

`--gates` **reemplaza** las compuertas del scope por completo: una etapa que dejes fuera de
la lista se vuelve `auto`, así que nombra todas las que quieras firmadas.

La política se congela al crear el run. Cambiarla después es deliberado y deja constancia:

```bash
tldrx run gates set build:human --note "the owner wants to read every merge from here"
```

## Deshacer una firma

Cuando se firmó algo que no se debía:

```bash
tldrx reject --stage 02-how/how --note "the auto gate signed over four open questions"
```

El cursor regresa a esa etapa, un evento `gate.revoked` registra quién había firmado, y las
etapas posteriores que ya habían corrido quedan marcadas `stale`: sus archivos siguen en
disco y dejan de contar como vigentes. No se borra nada, y no se reembolsa nada.

Cuando con lo que no estás de acuerdo es con una sola *story* de Build,
`tldrx story reopen <id> --note "…"` le da a esa story otra tanda de intentos y no toca
nada más. Una story que ya está `done` se niega — deshacer trabajo terminado es una decisión
sobre la etapa —, pero un defecto concreto en ella abre una **ronda de arreglo**:
`tldrx story reopen S11 --for-fix --note "which defect"`. No se consume ningún intento, el
arreglo pasa el mismo DoD y el mismo revisor, no se tocan los criterios de aceptación, y
solo puede haber una ronda abierta a la vez. Existe para que un defecto aceptado no le
cueste el cierre a todas las demás stories de la etapa.
