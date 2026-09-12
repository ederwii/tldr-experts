---
title: Los archivos son el estado
---

# Los archivos son el estado

Casi todas las herramientas guardan su estado en un lugar que no puedes ver y te entregan
un resumen. tldrx no tiene ese otro lugar. Lo que escribe dentro de tu repo **es** el
estado: vuelve a leer esos archivos al inicio de cada comando para decidir qué sigue.

Eso trae tres consecuencias prácticas.

1. **Lo puedes leer.** No hay log que activar ni base de datos que consultar. Un `cat` al
   archivo y ya.
2. **Lo puedes arreglar.** Una etapa que entendió mal es un archivo que editas y vuelves a
   correr.
3. **Lo puedes compartir.** Haz commit de los directorios y quien clone el repo se lleva el
   run: las preguntas, las respuestas, el plan, el dinero gastado, las aprobaciones.

## Dos directorios

```
.tldrx/                          # lo que la herramienta sabe de tu proyecto
  workspace.yml                  # repos, stacks, ramas, y los comandos que puede correr
  map/                           # el mapa del código, una carpeta por repo
  memory/facts.yml               # cada respuesta que has dado, numerada
  experts/                       # en quién se apoyan las etapas, y qué han aprendido
  experts/<lang>-stack/overlays/ # overlays de framework, escritos por `expert packs enable`
  conventions/                   # cómo se escribe este repo

tldrx-work/260901-bulk-pricing/  # una carpeta por pieza de trabajo
  run.yml                        # el cursor, las compuertas, los costos — desde aquí se retoma
  budget.yml                     # techos, por run y por fase
  events.jsonl                   # bitácora de solo-agregar de todo lo que pasó
  01-what/ … 05-watch/           # una carpeta por etapa, con sus archivos de salida
```

## Los tres que importan

**`run.yml`** es dónde va el run y qué está esperando. El cursor, y una entrada por etapa
con su modelo, su techo, su costo real y su compuerta:

```yaml
created_with: "<tldrx version at run new>"
last_written_by: "<tldrx version at the last save>"
cursor: {phase: "01-what", stage: what, task: null}
budget: {ceiling_usd: 5.00, spent_usd: 0.00, per_agent_max_usd: 1.80}
gates_policy: {what: human, how: auto, plan: human, build: auto, watch: human}
```

Ese bloque `budget:` es un **espejo**, y lo único vivo ahí es `spent_usd`. `ceiling_usd` y
`per_agent_max_usd` son las cifras con las que se creó el run: `tldrx budget raise` mueve
`budget.yml`, que es donde vive el techo de verdad y lo que leen todas las pantallas y todos
los rechazos. Las llaves siguen en `run.yml` porque un formato `version: 1` sólo crece — son
el registro de cómo arrancó el run, no una segunda copia que haya que mantener al día.

Las dos líneas de versión dicen qué tldrx escribió el archivo: la que creó el run y la que
lo guardó por última vez. No son el `version: 1` de más arriba, que numera el FORMATO del
archivo. El comportamiento cambia entre releases, así que un run que no puede nombrar la
suya te deja preguntándole al git log qué había instalado ese día. Un run escrito antes de
que existieran se lee `not recorded`, que no es lo mismo que una adivinanza.

Es el *único* punto desde donde se retoma. `tldrx run auto` no guarda nada en memoria —
cada iteración vuelve a leer este archivo — así que matarlo a media corrida deja un run que
`tldrx next` retoma sin cambios.

**`.tldrx/memory/facts.yml`** son tus respuestas. Cada pregunta que contestas se vuelve un
hecho numerado, con quién lo dijo, cuándo y de qué pregunta salió. Antes de que cualquier
etapa te pregunte algo, se busca en este archivo: volver a preguntar algo que ya está
registrado aquí se trata como un bug del framework, no como una maña. Los hechos se
sustituyen o se retiran, nunca se editan encima.

No todo hecho nace de una pregunta. `tldrx facts add "…" --area <id> --decided-by owner`
registra uno directo: lo que mediste, lo que resultó ser cierto del workspace.
`--decided-by` es obligatorio a propósito: dice quién **decidió**, que no es lo mismo que
quién lo escribió, para que la decisión propia de un driver nunca se te cite después como
tuya. Todo prompt que lee el hecho lee esa atribución junto con él.

**`events.jsonl`** es un objeto JSON por línea, al que solo se le agrega al final, en el
orden en que pasaron las cosas:

```json
{"ts":"2026-09-01T17:06:05Z","run":"260901-bulk-pricing","type":"run.created","actor":"alanmartinez","cost_usd":0,…}
```

Es la fuente de `tldrx cost`, `tldrx replay` (el run contado como historia) y `tldrx retro`.

## Haz commit de los dos

`.tldrx/` y `tldrx-work/` van en git. `tldrx init` le agrega un bloque corto a tu
`.gitignore` que excluye únicamente lo que es local a la máquina o se regenera: el caché
del grafo, los archivos de lock vivos, el bundle del prompt en vuelo, los archivos `.bak`.
Todo lo demás está pensado para revisarse en un pull request como cualquier otro cambio.

Ese mismo bloque empieza *volviendo a incluir* `.tldrx/**` y `tldrx-work/**`, porque reglas
que tu repo ya traía los pueden esconder sin querer: el `[Ll]og/` de un proyecto .NET se
traga `04-build/log/<story>.md` y git no dice ni pío. `tldrx doctor` revisa cuatro de esas
rutas con `git check-ignore` y te nombra cualquier regla que siga escondiendo alguna.

Todos estos archivos abren con `version: 1`. Los esquemas nada más crecen.
