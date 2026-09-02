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
| lo mismo, más el mandato de `tldrx drive` | los subagentes de esa sesión | se le cobra a tu sesión | solo ante una decisión de verdad |

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
comandos, y el segundo escribe el mandato.

```bash
tldrx run new payments --scope feature --budget 25 \
  --attended-by host --gates what:agent,plan:agent,build:agent,watch:agent
tldrx drive --unattended 260101-payments    # el mandato: pégalo en la sesión
```

Un run que ya está abierto no necesita que le dejes ninguna de las dos banderas puestas de
antemano: el preflight del mandato desatendido las establece él mismo.
`tldrx run attend host <run>` para dejarlo atendido, y `tldrx run gates set <stage>:agent`
por cada etapa que delegaste, sobre una nota que cita tu propia delegación, para que el
cambio lo firmen tus palabras y no el criterio de quien maneja.

`tldrx drive` imprime texto plano para la sesión que va a manejar el run. Abre con el
**preflight**: si el run está atendido, la política de compuertas, y un `budget.yml` cuyo
techo quien maneja tiene que decir en dólares. Donde no logre establecer alguno de los tres,
se niega a empezar y nombra el comando que falló — las precondiciones son la disciplina, no
el trámite previo a ella. Luego viene el protocolo de tres papeles — un subagente que
programa, luego un revisor de solo lectura **nuevo**, que nunca es quien escribió el código,
y luego tú, verificando a los dos en el código y no en sus reportes —, la disciplina de
evidencia (etiqueta cada afirmación como *medida*, *inferida* o *supuesta*; nunca dejes que
un pipe se coma un código de salida; pregúntale al remoto por el remoto), qué se aparta en
vez de decidirse, con cuánto rigor revisar una story según lo que esté en juego, y sobre qué
se tiene que sostener una firma.

Va versionado con el paquete, así que no se puede desviar del binario como sí se desvía un
playbook pegado del historial de chat de alguien. No necesita workspace, no abre ningún run,
no lanza nada y no escribe nada. `--attended` imprime el otro mandato, para cuando tú estás
en el teclado cerrando cada compuerta; su preflight revisa esos mismos tres y no mueve
ninguno, porque una sesión que ahí te reacomodara una compuerta te estaría quitando la firma
en lugar de ganársela. Si le das un id de run, llena de un jalón todos los huecos `<run>`;
si no, usa el único run abierto, y donde el CLI se negaría a elegir entre dos, deja el
marcador en lugar de apuntar un mandato al run equivocado.

`--gates` reemplaza las compuertas del scope por completo, así que nombra todas las etapas
que quieras firmadas: lo que dejes fuera se vuelve `auto`. `tldrx run attend --none <run>`
le devuelve el run al framework.

El capítulo completo, incluido qué es lo que hace cumplir ese "nunca lanza nada" y las
cuatro maneras en que una compuerta `agent` se cae hacia una persona:
[10 — Unattended mode](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/10-unattended-mode.md).
