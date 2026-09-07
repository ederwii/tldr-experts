---
title: Evidencia
---

# Evidencia

La forma en que una IA falla cuando escribe sobre tu código es el párrafo muy seguro de sí
mismo sobre código que nadie abrió. La respuesta de tldrx es mecánica: **una
afirmación sin fuente no se escribe.**

Cada punto que una etapa escribe en su handoff tiene que terminar con un token de fuente.
Si alguno no lo trae, la etapa se rechaza — antes de la compuerta, no después.

```markdown
## Findings
- Hunt completion already emits a HuntCompleted event [src: api:src/Hunts/Hunt.cs:184]
- The lab SDK is generated, so a DTO change is a two-repo change [src: F003]

## Unknowns
- Retention period for historical rankings [src: absent:.tldrx/memory/facts.yml]

## Evidence ledger
- Contract project builds clean [src: $ dotnet build → exit 0]
```

## Los tipos de fuente

| Cómo se ve | Qué quiere decir |
|---|---|
| `api:src/Hunts/Hunt.cs:184` | un archivo y una línea — el archivo debe existir y la línea debe caer dentro del rango |
| `F003` | una respuesta que tú diste, sacada de `.tldrx/memory/facts.yml` |
| `Q6` | una pregunta hecha en este run |
| `$ dotnet build → exit 0` | un comando que se corrió — solo los que declara tu `workspace.yml`, y solo en el Evidence ledger |
| `https://…` | un documento; `http://` se rechaza |
| `graph:<node>` | un nodo del mapa de código |
| `absent:path/to/file` | *buscamos aquí y no había nada* |
| `aidlc:intents/260821/design.md:14` | una línea de la carpeta de intención de AI-DLC que destiló un `run new --from` — o `#Q3`, una de sus preguntas ya contestadas. Se registra, nunca se resuelve: esa carpeta vive fuera del workspace y puede que ya no exista para cuando alguien lea el handoff |

`absent:` es el que abarata la honestidad. "No hay política de reintentos" es una
afirmación, y así es como se le pone fuente. Se rechaza en una afirmación **positiva**
fuera de la sección `Unknowns`: no puedes citar un directorio vacío como prueba de que algo
existe.

**Un comando rechazado no lleva ninguna cita `$ … → exit <n>`.** Esa forma necesita un
código de salida, y un comando del Definition of Done que tu `workspace.yml` no declara — o uno
que necesita un shell, que la compuerta nunca abre — nunca corrió, así que no hay ninguno que
escribir. Tampoco se registra como `exit 126`. El Evidence ledger dice
`was REFUSED and never ran`, cita textualmente la frase de la compuerta, y en lugar del comando
apunta al log de revisión de la story. Un rechazo y un build en rojo son hechos distintos, y
solo uno de los dos es una medición.

## Tres resultados, no dos

Cada fuente resuelve a `ok`, `refused` o `unverified`.

- **refused** — el archivo no existe, la línea está fuera de rango, el id del hecho no está
  en `facts.yml`, el comando no es de los que tu workspace declaró. La etapa falla.
- **unverified** — nadie pudo comprobarlo. Todavía no hay `facts.yml`; el workspace no
  declara comandos; nada en el workspace cita esa URL. Esto **no** es una mentira y no
  reprueba la etapa — pero sí impide que una [compuerta auto](/es/concepts/gates) se
  cierre, porque una cita que nada puede comprobar es exactamente la que una persona
  debería leer.

Esta distinción se ganó a pulso. Antes de que existiera, seis de los ocho tipos devolvían
`ok` sin condiciones, y un handoff que citaba un id de hecho inventado, una pregunta
inventada y un nodo de grafo inventado para afirmar *"quitamos la verificación de auth de
/admin"* validó limpio, cerró su propia compuerta auto y adelantó el cursor. Eso fue una
prueba medida, no una hipótesis.

## Qué te dice el verificador, y qué no

Comprueba que la cita **resuelve**. Si la línea citada de verdad respalda la frase es otra
pregunta, y quien la contesta sigue siendo una persona parada en una compuerta. El trabajo
del verificador es volver imposibles las fallas baratas, para que tu atención se vaya a las
caras.

Dos reglas chicas que vale la pena conocer, las dos salidas de rechazos reales:

- El token tiene que ser **lo último** de la línea. La puntuación al final está bien;
  envolver la cita en backticks no — una primera corrida real fue rechazada con "9
  unsourced bullets" cuando los nueve traían su cita dentro de backticks. Ese caso ahora
  reporta *malformed citation*, porque los dos casos necesitan consejos distintos.
- Una sección que va vacía se escribe como `- none [src: absent:<what was looked at>]`,
  nunca como una frase en prosa. "No hay incógnitas que alcancemos a ver" es justamente la
  afirmación que más necesita una fuente.

## Una decisión dice quién la tomó, o dice que no lo dice

Una respuesta que registras es un hecho, y un hecho es justo lo que se le cita de vuelta a
cada etapa posterior. Por eso lleva quién **decidió**, que no es lo mismo que quién lo tecleó.

```bash
tldrx answer Q4 "B — rankings are global" --decided-by owner --repo api
```

`--decided-by owner|driver` es opcional en `answer` y obligatorio en `tldrx facts add`, y la
diferencia es honesta antes que prolija: el mismo camino de código también lo maneja el hook de
captura de respuestas, que se dispara con la edición de un agente igual que con la tuya, así
que no puede decir cuál de los dos contestó. Cuando nadie lo dijo, el hecho dice **not stated**
—nunca *owner*— y el comando lo imprime en stdout en lugar de dejar que lo descubras después.
Cada cierre del run, y el encabezado del handoff de Build, dicen después cuántas de las
decisiones del run nombran a quien decidió y cuántas no.

`--repo` acota el hecho, para que una decisión sobre un repo deje de aparecer en los prompts de
los demás. Sin la bandera, el alcance sale del propio `affects:` de la pregunta cuando alguna
entrada nombra un repo, y de nada en caso contrario: un alcance vacío significa *no se nombró
ningún repo*, nunca *todos los repos*. Un `--repo` que tu `workspace.yml` no declara se rechaza
antes de escribir nada.

## Una contradicción se vuelve una pregunta, no dos hechos vivos

Cuando una respuesta contradice léxicamente a un hecho ya registrado, la respuesta igual queda
registrada — y tldrx levanta una pregunta sobre cuál de los dos vale, en el mismo archivo donde
acabas de responder, con las opciones *reemplazar el viejo*, *reemplazar el nuevo* o *escribir
la corrección*. El hecho nuevo además lleva `conflicts_with`, así que un prompt que lo cite lo
dice.

Levanta la pregunta; nunca rechaza. La comprobación es léxica —la misma regla de solapamiento
de palabras que usa el hook de no-volver-a-preguntar— así que puede no ver dos respuestas
redactadas distinto que sí se contradicen, y puede saltar con dos que no. Rechazar por eso
dejaría que un conteo de palabras trabe un run sin nadie mirando. Por la misma razón la pregunta
levantada queda marcada `advisory:` y no detiene una [compuerta auto](/es/concepts/gates): la
compuerta dice cuántas se saltó, y todos los demás lectores listan la pregunta igual que a
cualquier otra. No se retira nada, no se reconcilia nada, y la ausencia de `conflicts_with` en
un hecho significa *no se detectó contradicción* — nunca *se comparó y coinciden*.

## La misma regla aplica al dinero

Cada dólar que imprime `tldrx cost` lo reportó el proveedor del modelo y se leyó de un
evento en el log del run. Nunca se multiplica un conteo de tokens por un precio. El trabajo
cuyo costo nunca se observó se reporta como `UNMETERED`, no como `$0.00`: un número que
falta y un turno gratis son afirmaciones distintas. Ver
[presupuestos](/es/concepts/budgets).

La gramática, las reglas de resolución y todos los rechazos están especificados en
[`docs/spec.md` §2.8](https://github.com/ederwii/tldr-experts/blob/main/docs/spec.md).
