---
title: Atendido o desatendido
---

# Atendido o desatendido

Hay tres maneras de correr una etapa, y la diferencia se reduce a una pregunta: **¿quién
lanza al subagente?**

## Las tres maneras

| | quién corre cada turno | qué cuesta | dónde se detiene |
|---|---|---|---|
| `tldrx next` / `tldrx run auto` | el framework lanza `claude -p` | medido por turno | en la primera compuerta humana o pregunta abierta |
| `tldrx run attend host`, manejado desde una sesión de Claude Code | los subagentes de esa sesión | se le cobra a tu sesión | en cada turno — tú lo manejas |
| lo mismo, más un mandato por escrito | los subagentes de esa sesión | se le cobra a tu sesión | solo ante una decisión de verdad |

`run auto` y `run attend host` se leen como dos velocidades de lo mismo. Son opuestos, y no
se combinan.

- **`run auto` es un motor.** Llama a `next` una y otra vez, sin interfaz, lanzando un
  subagente medido etapa tras etapa.
- **`run attend host` es un candado.** Pone un campo, no gasta nada, no corre ninguna
  etapa. De ahí en adelante el framework nunca lanza nada en ese run: cada turno es un
  apretón de manos `tldrx next --prepare` / `tldrx next --commit` con una sesión que
  manejas tú.

Mezclarlos se rechaza en lugar de adivinarse: `run auto` sobre un run atendido sale con
`1`, y un `tldrx next` a secas ahí sale con `4` e imprime el comando `--prepare` que
querías escribir.

## Cuál elegir

- **Un run chico que de todos modos ibas a estar mirando** → `tldrx run auto`. Un comando,
  y se detiene en el momento en que te necesita.
- **Una sesión de Claude Code ya abierta, y te importa el costo o la calidad** →
  `run attend host`, manejado desde ahí. El contexto ya está caliente, así que los turnos
  salen más baratos, y el framework escribe el paquete del revisor en vez de lanzar un
  segundo lector junto al que ya estás pagando.
- **CI o cron** → `run auto`. Es el único de los tres que no lleva una sesión detrás.

## Sin manos, con `run auto`

```bash
tldrx run auto --max-usd 12 --until build
```

```
01-what/what … done $1.21 · auto-approved
02-how/how … done $2.60 · awaiting human gate
```

Se detiene en una compuerta humana o una pregunta abierta (salida `4`), en una falla de
etapa (`5`), en un rechazo por presupuesto (`2`), o donde le digas con `--until <stage>`.
No guarda estado — cada iteración vuelve a leer `run.yml` — así que matarlo deja un run que
`tldrx next` retoma sin cambios. `--max-usd` se revisa *entre* etapas, así que puede
pasarse cuando mucho por lo que le toca a una etapa.

`--gate-agent` cambia únicamente lo que imprime al detenerse: una **tarjeta de decisión**
— la pregunta, sus opciones, la recomendación si la hubo, y el único comando que hay que
teclear — en lugar del bloque de estado de siempre.

## De noche, sin soltar la revisión

El caso exigente: nadie está viendo, y aun así quieres una revisión adversarial. Dos
comandos y un prompt. Para la tercera parte no hay palabra clave: el mandato es prosa que
escribes tú.

```bash
tldrx run new payments --scope feature --budget 25 \
  --attended-by host --gates what:agent,plan:agent,build:agent,watch:agent
tldrx run attend host 260101-payments      # or flip a run that is already open
```

Luego, dentro de la sesión, dile qué puede decidir y qué no. La forma que funciona:

> Maneja tú mismo cada etapa — `tldrx next --prepare <run>` y `tldrx next --commit <run>` —
> despachando tus propios subagentes. El framework nunca debe lanzar nada.
>
> Para cada story de Build, corre una revisión adversarial independiente con el apretón de
> manos `--review`: `tldrx next --prepare --review`, un subagente de solo lectura sobre el
> diff, y después `tldrx next --commit --review`. Su trabajo es encontrar en qué se
> equivocó quien programó.
>
> Aprueba una compuerta solo después de revisarla tú mismo — que las citas resuelvan, que
> cada ruta tocada sea una que este run declaró, que el diff corresponda a las stories que
> dice implementar — y deja esa revisión por escrito: `tldrx gate template`, llénala, y
> luego `tldrx approve --as-agent`.
>
> Interrúmpeme solo por una decisión nueva de producto, por subir un techo de presupuesto,
> o por trabajo que tenga que salirse del límite declarado. Todo lo demás lo decides tú, y
> lo registras.
>
> Nunca hagas push. El merge final es mío.

`--gates` reemplaza las compuertas del scope por completo, así que nombra todas las etapas
que quieras firmadas: lo que dejes fuera se vuelve `auto`. `tldrx run attend --none <run>`
le devuelve el run al framework.

El capítulo completo, incluido qué es lo que hace cumplir ese "nunca lanza nada" y las
cuatro maneras en que una compuerta `agent` se cae hacia una persona:
[10 — Unattended mode](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/10-unattended-mode.md).
