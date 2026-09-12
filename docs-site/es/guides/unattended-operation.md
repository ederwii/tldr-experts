---
title: Operar un run desatendido
---

# Operar un run desatendido

"Desatendido" acá no quiere decir *que nadie decide nada*. Quiere decir que **nadie tiene
que estar mirando una terminal** para que el run siga avanzando, y que los momentos en los
que de verdad hace falta una persona le llegan a esa persona donde esté — en lugar de pasar
de largo en una ventana que nadie tiene abierta.

Cuatro cosas siguen siendo de una persona, siempre: una decisión de producto nueva, subir un
techo de presupuesto, trabajo que se sale del límite que citó el What, y el merge final.
Todo el diseño de acá se trata de volver esas cuatro alcanzables en segundos, no de
quitarlas.

## Las dos maneras de conducir un run

**Una sesión anfitriona — `tldrx run attend host`.** Un candado, no un motor: pone un solo
campo en el run y de ahí en adelante el framework nunca lanza nada sobre él. Cada turno es
un intercambio `tldrx next --prepare` / `tldrx next --commit` con una sesión que tú
conduces, así que te quedas con el criterio de esa sesión y con sus propias herramientas, y
ya puede alcanzarte porque estás hablando con ella. Lo que cedes es la medición — esos
turnos se cobran a tu sesión, no se miden por etapa — y el paralelismo: una sesión
anfitriona conduce un turno a la vez. Este es el modo para el que
[`tldrx drive`](/es/guides/driving#de-noche-sin-soltar-la-revision) escribe un mandato.

**El motor — `tldrx run auto`.** Un bucle sin terminal que llama a `next` una y otra vez,
lanzando un sub-agente medido etapa tras etapa. Obtienes un medidor de dólares por etapa, un
modelo impuesto, y las stories de una misma ola de build corriendo en paralelo. Lo que no
tiene es cómo alcanzar a nadie: anuncia una pregunta abierta o una compuerta saliendo con
`4` e imprimiendo en **stdout**. Todo lo de abajo es cómo darle una manera.

Los dos no se combinan, y mezclarlos se rechaza en lugar de adivinarse: `run auto` sobre un
run marcado `attended_by: host` sale con `1`, antes de abrir siquiera el registro de
eventos.

## Declarar el hook

Un bloque opcional en `.tldrx/workspace.yml`. Un workspace sin él no notifica nada y se
comporta exactamente como antes de que existiera la clave.

```yaml
notify:
  command: "bin/notify-owner"          # una sola línea argv, como `commands:` — no se abre ningún shell
  events: [question.raised, gate.requested, run.failed]   # opcional; omitido significa todos los tipos
  timeout_s: 30                        # opcional; el techo de una invocación
```

- **`command` es argv, nunca una línea de shell.** Se parte y se ejecuta directo, igual que
  cualquier otro comando que declara un workspace, y un metacarácter de shell suelto
  (`|`, `&`, `;`, `<`, `>`, `$`, backtick, paréntesis, llaves, `*`, `?`, `~`) se **rechaza**
  en vez de pasarse por un shell. Si necesitas un pipeline, ponlo en un script y declara el
  script. La carga tampoco toca nunca la línea de comandos: si no, el título de una pregunta
  podría volverse sintaxis de shell.
- **`events` filtra por tipo.** Omitirlo significa *todos* los tipos, a propósito: quien
  declaró un comando quiere enterarse del run, y un valor por defecto que se suscribiera a
  nada en silencio sería un hook configurado que nunca dispara y nunca dice por qué. Un tipo
  desconocido es un error de validación.
- **`timeout_s` acota una invocación** (30 segundos por defecto). Un notificador es un
  aviso, no un trabajo.
- **Un notificador que falla nunca cambia el run.** Un comando que no se puede partir, un
  binario que no está, una salida distinta de cero, un vencimiento: cada uno queda anotado
  como un evento `notify.failed` con su razón y ahí se deja. "No se le avisó a la persona, y
  esta es la razón" es un hecho sobre el run; "el canal lateral se cayó, así que el run
  falló" volvería ese canal lateral indispensable. Uno entregado es `notify.sent`, con el
  tipo, el código de salida del hijo y su duración. Los dos cuestan `$0.00`.

`tldrx init` escribe el bloque **comentado**, con una línea que dice para qué es. No adivina
un comando: a quién se despierta no es algo que se detecte.

## La carga

Un solo objeto JSON por **stdin**, `version: 1`, con las mismas nueve claves de primer nivel
siempre: `version`, `kind`, `at`, `run`, `root`, `stage`, `summary`, `command`, `detail`.

`summary` es un párrafo escrito para leerse en la pantalla de bloqueo. `command` es la línea
exacta a teclear, con el id del run ya adentro — o `null`, honestamente, cuando no hay nada
que hacer; un siguiente comando inventado sería el framework adivinando una intención.
`stage` es `<phase>/<stage>`, o `null` cuando el aviso es sobre el run entero. `root` es la
raíz absoluta del workspace, porque a un script nadie más le dice dónde vive el run.
`detail` es propio de cada tipo y siempre es un objeto.

### `question.raised` — para el que existe toda la función

```json
{
  "version": 1,
  "kind": "question.raised",
  "at": "2026-09-07T18:20:04.117Z",
  "run": "260907-checkout",
  "root": "/Users/alan/code/checkout",
  "stage": "01-what/what",
  "summary": "260907-checkout stopped at 01-what/what on 1 open question(s): Q1 · Should an abandoned hunt count toward the leaderboard?. The run is parked until one is answered; nothing is being spent while it waits.",
  "command": "tldrx answer Q1 \"…\" --run 260907-checkout",
  "detail": {
    "questions": [
      {
        "id": "Q1",
        "title": "Should an abandoned hunt count toward the leaderboard?",
        "why_asked": "no rule for abandoned hunts exists in memory [src: absent:.tldrx/memory/facts.yml]",
        "options": [
          { "letter": "A", "text": "count them" },
          { "letter": "B", "text": "drop them" }
        ],
        "recommendation": { "option": "B", "why": "matches how players talk about it", "src": "01-what/handoff.md:22" },
        "answer_command": "tldrx answer Q1 \"…\" --run 260907-checkout"
      }
    ]
  }
}
```

El `command` de primer nivel es el comando de respuesta de la **primera** pregunta: una
carga tiene un solo espacio para `command`, y las preguntas se responden de una en una. Un
script que quiera dibujar un botón por pregunta lee `detail.questions[]`. Las opciones
llegan como `{letter, text}` y no como una línea `A) …` ya formateada, así que armar botones
con ellas no obliga a re-parsear una cadena que el framework ya había parseado.

`recommendation` sale de uno de dos lugares, y es `null` cuando ninguno traía una — nunca una
fabricada. La nota de evidencia de una compuerta `agent` (`recommend:`) gana; si no la hay,
manda la línea opcional `Recommended:` del propio bloque de la pregunta, que escribe la etapa
que la levantó:

```
- A) count them
- B) drop them

Recommended: B — matches how players talk about it [src: 01-what/handoff.md:22]

[Answer]:
```

Esa línea existe porque solo una compuerta `agent` escribe una nota, así que las preguntas
detenidas en una compuerta `auto` llegaban sin ninguna guía — mientras que la etapa que las
levantó era lo único en el run que conocía el compromiso. Una línea `Recommended:` que el
parser no puede leer se ignora, nunca se rechaza: es una guía, así que un error de tipeo
cuesta la guía y no la compuerta.

### Lo que vas a ver cuando una compuerta `auto` está esperando

Cambiaron dos cosas en el orden y el contenido de lo que te llega, y las dos son sobre una
compuerta `auto` retenida únicamente por preguntas abiertas:

- **Las preguntas llegan primero, y puede que la compuerta no llegue nunca.** Cuando lo ÚNICO
  que retiene una compuerta auto son sus preguntas abiertas, la compuerta está río abajo de
  ellas y no es un segundo pedido — así que `question.raised` se entrega primero y el aviso de
  `gate.requested` se retiene. Recibís "esto hay que decidir", no "firmá esto" seguido de "y
  acá está por qué". El EVENTO `gate.requested` se anexa igual al log del run; lo único que
  espera es el aviso.
- **La compuerta se cierra sola cuando respondés.** Con `--wait-gates`, cada consulta vuelve a
  correr las siete condiciones auto, y apenas se cumplen todas el bucle firma la compuerta por
  la misma puerta `tldrx approve` y sigue a la etapa siguiente. Así que la secuencia que vas a
  ver de verdad es: las preguntas, tus respuestas desde el teléfono, y después `stage.done` de
  la SIGUIENTE etapa. Ningún toque de aprobar.

Si lo que retiene la compuerta es OTRA cosa — una cita sin verificar, una etapa por encima de
su techo — salen los dos avisos, primero las preguntas, y el resumen de la compuerta nombra la
condición: *"…is waiting at an auto gate that did not close by itself — a person signs it. It
is held by: claim-sources=1 unverified citation(s) — …"*. Antes, esa frase decía solamente
"did not close by itself" y no nombraba nada.

**Una compuerta de Build nombra el resultado de las historias.** La firme quien la firme —
`human`, `agent` o `auto` — el aviso de la compuerta de Build dice qué entregó la etapa antes
de decir cuánto costó:

> *"260909-scoring finished 04-build/build for $1.78 and is waiting at a human gate — a person
> signs it. It has 0 of 3 stories delivered, S1 blocked (npm run test exited 127…), S2 not
> started.
> Nothing runs after it until the gate is approved or rejected."*

Los conteos y el motivo de la primera historia bloqueada viajan en el payload de
`gate.requested` como `stories`, `blocked_story` y `blocked_reason`, así que un script puede
enrutar con ellos. **Lo que RETIENE la compuerta también viaja, como campo**: `holding` es
`questions`, `stories` o `none` — la misma rama por la que se eligió el `command` de arriba,
dicha una vez como dato, para que un adaptador nunca tenga que olfatearla del prefijo de una
cadena de CLI. Y donde la compuerta puede nombrar con sus propias palabras qué hay que cambiar,
lleva además `continue_command` — `tldrx reject --run <id> --and-continue --note "…"`, el
*«rehacelo así y seguí»* de un solo toque — con `continue_note`, la nota derivada de la historia
bloqueada y del motivo que el handoff registró. Ese par está AUSENTE en una compuerta retenida
por preguntas abiertas (aprobar o rechazar es justo lo que no debe pasar antes de responderlas),
en una retenida por nada mecánico (el motivo para rechazar un juicio está en tu cabeza, no en el
disco) y en una cuya historia bloqueada no registró motivo. La nota de un rechazo entra al
prompt del turno siguiente, así que un *«rechazado desde Slack»* enlatado cumpliría con la
bandera y le daría a la re-corrida una instrucción vacía: es mejor ningún botón que un botón que
no dice nada. El motivo es la frase del propio handoff, nunca una paráfrasis. Dos runs
reales se aprobaron desde el teléfono sobre un resumen que decía `$1.78` y un chequeo en verde
mientras todas las historias estaban bloqueadas — el conteo ya existía y corría solo para las
compuertas `auto`.

**Y el final del run también lo dice.** Un run cuyo Build no entregó nada no te llega como un
`done` a secas: `run.finished` dice *"…the loop finished with exit 0 (ok), $1.78 spent by this
loop. The run: nothing delivered: 0 of 3 stories; S1 — npm run test exited 127."* La misma
frase queda en `run.yml` como `outcome:`, en `tldrx run status`, en el tablero y en el cuerpo
del PR de `tldrx ship` — y `tldrx ship` rechaza un run así en vez de abrir un PR cuya sección
"What shipped" está vacía.

### `status` — el latido

```json
{
  "version": 1,
  "kind": "status",
  "at": "2026-09-07T18:30:04.002Z",
  "run": "260907-checkout",
  "root": "/Users/alan/code/checkout",
  "stage": "02-how/design",
  "summary": "260907-checkout is still running at 02-how/design. Nothing is waiting on you — this is the periodic heartbeat `--notify-every` asked for.",
  "command": "tldrx run status 260907-checkout",
  "detail": { "status_text": "…lo que imprime `tldrx run status`, textual…", "waiting_on": [] }
}
```

Cuando `waiting_on` **no** está vacío el latido cambia lo que dice: nombra las preguntas
abiertas y su `command` pasa a ser la línea literal de `tldrx answer`. Un latido que
siguiera diciendo "nadie te está esperando" mientras el run está detenido sobre la respuesta
de alguien sería peor que el silencio, porque a un latido se le cree. Que un run esté
detenido lo decide el mismo predicado que consulta `--wait-answers` y sobre el que se detiene
`next`, nunca una segunda opinión.

Un run detenido en una **compuerta** tenía exactamente el mismo agujero, y se cierra igual.
Mientras una firma está pendiente la carga suma dos claves:

```json
"detail": {
  "status_text": "…lo que imprime `tldrx run status`, textual…",
  "waiting_on": [],
  "waiting_on_gate": "01-what/what",
  "gate_policy": "human"
}
```

…el resumen dice que el run está esperando que una persona firme esa etapa, y `command` pasa a
ser la única línea que la LIBERA — el mismo mapeo que usa `gate.requested`, sobre la misma
lectura del run: `tldrx answer <id>` mientras la compuerta además tenga preguntas abiertas,
`tldrx run status <id>` mientras una compuerta de Build tenga historias sin terminar, y
`tldrx approve --run <id>` cuando la firma sea de verdad lo único que falta. Una compuerta retenida por cinco preguntas sin responder ofrecía `approve` y lo repetía
en cada intervalo, y así se aprobaron por error dos compuertas de Build en una sola noche sobre
historias sin construir. `waiting_on_gate` es una clave **hermana** de `waiting_on`,
no un miembro de ella: un adaptador convierte cada id de `waiting_on` en `tldrx answer <id>`,
y un id de etapa ahí lo haría armar un comando que nadie puede teclear. Las dos claves están
**ausentes** cuando no hay compuerta pendiente, así que un adaptador escrito antes de que
esto existiera ve la carga de siempre.

### Los nueve tipos

El conjunto es cerrado — un tipo que llegara de la nada sería una rama que nadie escribió —
así que un `switch` sobre `kind` con un `default` es un adaptador completo.

| tipo | cuándo dispara | qué lleva `command` | `detail` |
|---|---|---|---|
| `question.raised` | el bucle se detuvo en una pregunta abierta | la línea `tldrx answer` de la primera pregunta | `questions[]` — `id`, `title`, `why_asked`, `options[]` como `{letter, text}`, `recommendation` (`option`, `why`, `src`) o `null`, `answer_command` |
| `question.timeout` | se venció `--wait-answers` y el bucle está por salir con `4` | la misma línea de respuesta | los mismos `questions[]`, más `waited_ms` |
| `gate.requested` | una etapa terminó y una persona tiene que firmarla — **se difiere, y puede que nunca se mande, cuando una compuerta `auto` está retenida solo por preguntas abiertas** | la línea que LIBERA la compuerta: `tldrx answer <id>` si hay preguntas abiertas, `tldrx run status <id>` si quedan historias sin terminar, `tldrx approve --run <id>` cuando no queda nada mecánico pendiente | `cost_usd`, `approve_command`, `reject_command`, `gate_policy`, `holding` (`questions` \| `stories` \| `none`), y uno de `held_by` (las condiciones que fallaron en una compuerta `auto`) / `signer_held` (las razones del firmante `agent`) — ausente cuando nadie miró. Más `continue_command` + `continue_note`, juntos o ninguno, solo donde la compuerta puede nombrar qué hay que cambiar |
| `gate.timeout` | se venció `--wait-gates` y el bucle está por salir con `4` | la misma línea de aprobación | `approve_command`, `reject_command`, `gate_policy`, `waited_ms`, y `cost_usd` solo cuando este bucle es el que vio levantarse la compuerta |
| `stage.done` | una etapa terminó y el bucle siguió | `null` — el bucle ya está corriendo la siguiente etapa | `cost_usd` |
| `run.finished` | el bucle terminó con salida `0` | `null` | `exit_code`, `exit_family`, `spent_usd` |
| `run.failed` | el bucle terminó con cualquier salida distinta de cero, rechazos incluidos | `tldrx run status <id>` | `exit_code`, `exit_family`, `spent_usd` |
| `budget.warned` | un techo está cerca | `tldrx budget show --run <id>` | `spent_usd`, `ceiling_usd` |
| `status` | cada `--notify-every <duration>` mientras el bucle corre | `tldrx run status <id>`, o la línea de respuesta cuando está detenido en una pregunta, o — en una compuerta — la misma línea que la libera | `status_text` — lo que imprime `tldrx run status`, textual — `waiting_on`, los ids de las preguntas abiertas que lo detienen (`[]` si no hay), y `waiting_on_gate` + `gate_policy` solo mientras hay una compuerta pendiente |

**Una entrada truncada viaja en el resumen, y no agrega un tipo.** Cuando el `inputs_max_bytes`
de una etapa no pudo entrar una entrada declarada entera, los resúmenes de `stage.done`,
`run.failed` y `status` terminan con una oración más — *"1 input truncated: facts.yml 169 KB →
87 KB (cap 96 KB)."* — así el `switch` que ya escribiste sigue funcionando, y te enterás de que
un subagente leyó un prefijo y no el archivo mientras la corrida sigue viva, en vez de
descubrirlo en `.agent/<stage>/prompt.md` después de que falló.

`exit_family` es el código de salida en palabras, para que un aviso en un teléfono diga
*"refused — a budget ceiling or a gate said no"* y no *"exit 2"*. Las preguntas, sus opciones
y su recomendación son la **misma tarjeta** que imprime `run auto --gate-agent`, así que un
aviso y una terminal nunca pueden discrepar sobre qué se preguntó.

## Un adaptador, en unas treinta líneas

El framework no trae integración con ningún servicio de mensajería, y no la va a traer. A
cada quien lo alcanza algo distinto, y una integración incluida sería el framework decidiendo
de qué producto depende el run de todo el mundo: la configuración de un operador convertida
en dependencia de la de todos los demás. La consola es el valor por defecto porque es la
única superficie que todo run tiene; de ahí en adelante es tuyo, y tldrx se remite a eso sin
saber qué es.

Así que el adaptador es la pieza que tú tienes. Node, sin dependencias, sin más conocimiento
del framework que la carga:

```js
#!/usr/bin/env node
// bin/notify-owner — lee una carga notify por stdin.

// Reemplaza esto por lo que sea que te alcance: un POST HTTP, un correo, un ticket, un teléfono.
async function sendToMyChannel(title, body, action) {
  console.log([title, body, action].filter(Boolean).join("\n"));
}

let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", async () => {
  const p = JSON.parse(raw);
  const action = p.command ? `Run this to unblock it:\n${p.command}` : null;

  switch (p.kind) {
    case "question.raised":
    case "question.timeout":
      // Cada pregunta, con sus opciones y su propio comando de respuesta.
      for (const q of p.detail.questions) {
        const options = q.options.map((o) => `${o.letter}) ${o.text}`).join("\n");
        await sendToMyChannel(`${p.run} · ${q.id}: ${q.title}`, `${options}\n\n${q.why_asked}`, q.answer_command);
      }
      break;
    case "gate.requested":
    case "gate.timeout":
    case "budget.warned":
    case "run.failed":
      await sendToMyChannel(`${p.run} · ${p.kind}`, p.summary, action);
      break;
    default: // stage.done, run.finished, status — son reportes, no hay nada que teclear
      await sendToMyChannel(`${p.run} · ${p.kind}`, p.summary, action);
  }
});
```

Después `chmod +x bin/notify-owner` y decláralo. El ciclo se cierra cuando una persona lee
ese mensaje y corre el comando que traía — `tldrx answer Q1 "B — rankings are global" --run
260907-checkout`, desde una laptop, desde un teléfono por SSH, o desde un botón en tu propio
script que lo ejecute en su nombre. Es un `tldrx answer` común y corriente; el bucle nunca
responde su propia pregunta.

## Ponerlo a correr

```bash
tldrx run auto 260907-checkout --notify-every 10m --wait-answers 4h --wait-gates 4h --retry-failed 2
```

Las tres banderas toman una **duración**: `30s`, `10m`, `2h`, o un número pelado de segundos.
Un valor que no sea una duración se rechaza con salida `1`.

- **`--notify-every <duration>`** agrega la carga `status` periódica. Apagada por defecto, y
  no hace absolutamente nada si no hay un comando `notify:` declarado. Existe porque el rato
  en el que más quieres saber que un run sigue vivo son los veinte minutos que pasa dentro de
  una etapa.
- **`--wait-answers <duration>`** cambia dónde se detiene el bucle ante una PREGUNTA. En vez
  de salir con `4` apenas una etapa se detiene en una pregunta abierta, consulta los archivos
  de preguntas del run durante ese rato y **retoma solo** si alguien responde. No se gasta
  nada mientras espera. Cuando el plazo se vence manda un `question.timeout` y entonces
  **sale con `4`** con las mismas líneas de siempre: el run queda intacto, no se perdió nada,
  y `tldrx run auto` lo retoma en cuanto la pregunta esté respondida.
- **`--wait-gates <duration>`** hace lo mismo con una COMPUERTA, la otra mitad de la salida
  `4`. Es una bandera hermana y no un `--wait-answers` más ancho, porque las dos detenciones
  se cierran con verbos distintos: `tldrx answer` para una, `tldrx approve` / `tldrx reject`
  para la otra, y llamarle "respuesta" a una firma sería que el nombre de la bandera mienta
  sobre lo que hiciste. Aprueba dentro de la ventana y el bucle sigue a la etapa siguiente;
  rechaza y se detiene, imprimiendo tu nota; deja que se venza y manda un `gate.timeout` y
  sale con `4`. No se gasta nada mientras consulta.

  Un rechazo son dos actos distintos bajo un mismo verbo, y es el rechazo el que dice cuál de
  los dos es, en vez de que el bucle lo adivine. Un `tldrx reject` pelado significa *pará, lo
  quiero mirar* y termina el bucle, como siempre: seguir sería volver a gastar la etapa sobre
  una decisión cuyo resultado no viste. `tldrx reject --and-continue` significa *rehacelo así y
  seguí* — la etapa vuelve a `ready` con tu nota igual que siempre, y el bucle la vuelve a
  correr en lugar de salir, que es lo que hacía relanzarlo a mano. Nada de esto se deduce de
  las palabras de tu nota.

  Espera UNA firma, y solo la produce donde el run ya había dicho que podía: una compuerta
  `auto` se vuelve a evaluar en cada consulta y se firma apenas se cumplen sus siete
  condiciones (más abajo). Para `human` y `agent` no produce ninguna — y para cuando está
  esperando una compuerta `agent`, el firmante del propio motor ya tuvo su turno (más abajo),
  así que lo que queda por esperar es una PERSONA.
  Aprobar tú mismo una compuerta con política `agent` es una anulación registrada y siempre
  está permitida. El latido y la carga `gate.requested` nombran la política, así que sabes
  cuál de las dos estás haciendo.

## Quién cierra una compuerta cuando conduce el motor

Tres políticas, tres cosas distintas al terminar una etapa:

- **`human`** — el bucle se detiene y firma una persona: `tldrx approve`, o `tldrx reject
  --note "…"`. Con `--wait-gates` el bucle espera esa firma en vez de salir en el acto.
- **`agent`** — el motor lanza un **firmante de compuerta** acotado y propio: el modelo y el
  esfuerzo de la etapa, un cuarto del techo por agente de la etapa, con permiso para leer lo
  que sea y escribir exactamente un archivo, `.agent/<stage>/evidence.md`. Esa nota pasa
  después por el camino de siempre, `tldrx approve --as-agent` — el mismo validador por el
  que pasa la nota de una persona. Un `verdict: sign` con todas las condiciones cumplidas y
  cada afirmación con su `[src: …]` cierra la compuerta bajo el `by:` de la nota, y el bucle
  sigue. Cualquier otra cosa — `refuse`, `sign-with-fixlist`, una nota que no valida, un
  firmante que no escribió nada — deja la compuerta pendiente para ti, con las razones en la
  carga `gate.requested`. El turno queda registrado como `agent.spawned` / `agent.result`
  con `role: gate-signer` y aparece en `tldrx cost`. No hay bandera: `gates_policy: agent`
  ya es tu decisión registrada de que un agente puede cerrarla.
- **`auto`** — sin firmante y sin nota: siete condiciones medidas, y la compuerta cierra solo
  si se cumplen las siete. Si no, cae hacia una persona con las que fallaron nombradas, tanto
  en `held_by` de la carga `gate.requested` como en stdout. Y la oferta sigue en pie: con
  `--wait-gates` las siete se vuelven a medir en cada consulta, así que una compuerta retenida
  por una pregunta abierta se cierra sola apenas se responde la pregunta. Solo `auto` — el run
  ya concedió esa autoridad — y tu propio `approve` o `reject` la anula en cualquier momento.

Las dos banderas de espera pueden darse juntas — esa es la forma de un lanzamiento del todo
desatendido: `--wait-answers 4h --wait-gates 4h`.

## Reintentar una etapa que falló

`--retry-failed <n>` es la única bandera de aquí que es una CUENTA y no una duración: cuántas
veces seguidas el bucle puede volver a correr una etapa **fallada** antes de detenerse. `0` es
el valor por defecto, y es lo que recibió toda invocación anterior a esto — un intento, y
luego salida `5`.

Un reintento es el mismo `tldrx next` que habrías tecleado vos. La etapa queda en disco como
`failed` con su razón registrada, y el prompt del siguiente intento sabe qué hizo el anterior
— que es justo por lo que vale la pena automatizarlo: medido en un run desatendido real, un
plan que falló una verificación por cinco caracteres pasó en el intento siguiente, sin ninguna
instrucción nueva de nadie.

Tres cosas lo acotan, y las tres importan:

- **Acota la salida `5` y nada más.** Un error de uso (`1`), un rechazo por dinero (`2`) y una
  parada a la espera de una persona (`4`) se intentan una sola vez, por más grande que sea
  `n`. Cada una es una decisión tuya — el techo de fase sobre todo, que significa *una persona
  decide sobre el dinero*, y un reintento convertiría esa frase en una demora.
- **Solo cuentan las fallas consecutivas.** Una etapa que sale bien vuelve la cuenta a cero,
  así que un run largo con una falla recuperable por fase nunca agota una cota pequeña. Lo que
  se acota es "este run está trabado", no "este run falló alguna vez".
- **Un reintento gasta.** Es una etapa medida más, bajo el mismo techo de fase y el mismo
  `--max-usd`. Cuando la cota se agota el bucle se detiene con la salida `5` de la falla
  misma, y la última línea dice la cuenta — `3 consecutive stage failures at 03-plan/plan …` —
  para que la carga `run.failed` en tu teléfono diga que el bucle lo intentó, en vez de un `5`
  pelado.

El máximo es `3`; cualquier valor mayor se rechaza por nombre con salida `1`.

La salida `4` no es una falla. Es "esperando a una persona", y con el hook declarado a esa
persona ya se le avisó; lo que queda es tu bucle externo de relanzamiento, que te toca
escribir a ti.

Vale la pena nombrar las dos cosas que ganas frente al modo anfitrión, porque son justo lo
que el aviso te devuelve:

- **Paralelismo.** `--parallel <n>` define cuántas stories de una misma ola de build corren a
  la vez. `waves.yml` ya garantiza que una dependencia está en una ola anterior, así que las
  stories de una ola son independientes por construcción. La etapa de build que viene incluida
  declara `parallel: 2`, así que dos a la vez es lo que obtiene un workspace que no sobrescribe
  nada.
- **El medidor.** Cada turno lanzado se mide por etapa y por intento. `tldrx cost` imprime lo
  que costó el trabajo de verdad, `tldrx cost --stories` pone cada story junto al techo que se
  le dio a su lanzamiento, y un techo que se está acercando llega como un aviso
  `budget.warned` con los dos números adentro.

## Lista para la primera corrida

1. **Declara `install:`** en `.tldrx/workspace.yml`, para cada repo cuyo comando de tests
   necesite dependencias instaladas. Una historia de Build corre en un `git worktree` recién
   creado: tiene tus archivos versionados y nada más — sin `node_modules`, sin virtualenv, sin
   paquetes restaurados, y sin nada de tu propio checkout. tldrx corre ahí el instalador
   declarado antes del developer y lo registra como su propio check, con código de salida y
   duración. Sin eso, el DoD de la historia sale con `127` y la bloquea, después de haber
   pagado un turno; el mensaje nombra el binario ausente y esta ranura, y el framework no
   adivina ningún instalador por ti.

   ```yaml
   repos:
     - name: app
       commands:
         install: "npm ci"      # pnpm install --frozen-lockfile, uv sync, dotnet restore, …
         test: "npm run test"
   ```
2. **Declara `test_fast`** en `.tldrx/workspace.yml`: el subconjunto rápido sobre el que
   itera el developer de Build. No es un comando de Definition of Done; el DoD vuelve a
   correr `test:`.
3. **Escribe el adaptador y decláralo** bajo `notify:`. Empieza con todos los tipos y
   angosta `events:` después, cuando ya sepas cuáles quieres que de verdad te despierten.
4. **Prueba el adaptador a mano**, antes de que ningún run dependa de él:

   ```bash
   echo '{"version":1,"kind":"status","at":"2026-01-01T00:00:00Z","run":"demo","root":"'"$PWD"'","stage":null,"summary":"hello","command":null,"detail":{"status_text":"hello","waiting_on":[]}}' | bin/notify-owner
   ```

   Si eso no te llega, nada te va a llegar.
5. **Lanza primero con un intervalo corto** — `--notify-every 60s` para una etapa — para
   enterarte de que el hook funciona mientras sigues frente al teclado. Después súbelo.
6. **Mira `tldrx run status`** para la vista del propio run, y `tldrx replay <run>` para el
   registro de eventos como relato, `notify.sent` / `notify.failed` incluidos.

## Cuando algo no sale

**Una historia bloqueada con `exit 127`, "command not found".** Los tests nunca corrieron: el
worktree de la historia no tenía el binario. Declara `install:` (punto 1 de arriba) y tldrx
instala ahí las dependencias antes del developer. El check que falló trae `tree: "worktree"`,
así que se distingue del pre-vuelo de entrada a Build, que corre el mismo comando en tu propio
checkout — donde las dependencias ya están, que es por qué puede estar verde minutos antes.

**El developer dice "This command requires approval to run".** Arreglado en gh #209: cada
comando declarado ahora se concede tanto exacto como con argumentos al final, así que un
developer puede correr `npm run test -- un/archivo.test.ts` mientras trabaja, y no sólo el
comando pelado.

**El notificador nunca se llama.** Tres causas habituales, en el orden que cuesta menos
revisar. La lista `events:` no nombra el tipo que esperabas: quita la clave por completo para
suscribirte a todo. El comando no es ejecutable, o no está en la ruta desde la que el run lo
resuelve — `bin/notify-owner` es relativo a la raíz del workspace, y necesita su bit de
ejecución. O la línea del comando trae un metacarácter de shell y se rechazó en vez de
pasarse por un shell: mueve el pipeline a un script y declara el script.

**Un bloque `notify:` mal formado se lee como si no hubiera bloque.** El lector no puede
producir un hook que el validador rechazaría, así que un bloque roto no notifica nada en
lugar de lanzar algo sin revisar. `tldrx doctor` es donde se reporta un bloque malo.

**`notify.failed` en `events.jsonl`.** El evento trae la razón en palabras: que necesita un
shell, que no se pudo arrancar, que no existe el ejecutable, que venció después de N ms y se
mató, o `exit <n>` con una cola de la salida del hijo. Léelo con `tldrx replay <run>`. Diga
lo que diga, el resultado del run no cambia.

**Se venció `--wait-answers`.** Recibes un `question.timeout` con `waited_ms` y los mismos
`questions[]`, y después la salida `4`. Responde la pregunta y vuelve a arrancar el bucle: no
se perdió nada y no se gastó nada mientras esperaba.

**Se venció `--wait-gates`.** Recibes un `gate.timeout` con `waited_ms`, las líneas de
aprobar y rechazar y la política de la compuerta, y después la salida `4`. Firma o rechaza la
compuerta y vuelve a arrancar el bucle. Si la compuerta tiene `gates_policy: agent` y
esperabas que el run siguiera solo: no lo hará — el bucle no firma nada, y una compuerta
`agent` dice quién PUEDE firmar, no que algo ya haya firmado.

**Un árbol de trabajo sucio ya no detiene el run.** La entrada de Build clasifica cada ruta sin
commitear en vez de contarla. Todo lo que esté bajo `tldrx-work/`,
`.tldrx/` o `.agent/` es estado propio del framework y se ignora; una ruta sucia que una
historia pendiente declara en su `touches:`, o un submódulo, sigue rechazando con salida `2`;
todo lo demás se **aparta** con un `git stash push` limitado por pathspec antes de cortar la
rama del épico, y se devuelve cuando la etapa termina. Ambos momentos quedan en el log
(`worktree.foreign_work_aside`, `worktree.foreign_work_restored`) y nada se borra ni se
recupera a la fuerza. Si git rechaza el `pop` — porque el árbol cambió esa ruta mientras tanto
— la ÚLTIMA línea de la etapa, la sección `## Unknowns` del handoff y la notificación
`stage.done` / `run.finished` dicen `foreign work NOT restored`, con el stash y el comando
literal para recuperarlo. El código de salida del run no cambia por eso.

**Un repo en medio de un merge o un rebase rechaza (salida `2`).** Ese estado no tiene forma
limpia de deshacerse, así que no se guarda nada ahí. Terminá o abortá la operación y volvé a
arrancar el loop.

**El run se rechaza con salida `1`.** `run auto` no corre sobre un run marcado
`attended_by: host` — un candado y un motor son alternativas, nunca capas. Devuélvele el run
al framework con `tldrx run attend --none <run>`, o condúcelo desde una sesión.
(`tldrx run attend host <run>` es la dirección contraria.)

**Un rechazo por presupuesto (salida `2`).** `--max-usd` se revisa *entre* etapas, así que el
bucle puede pasarse cuando mucho por lo que le toca a una etapa. `tldrx budget show` dice qué
queda; subir un techo es decisión de una persona, y no hay bandera que lo deje de ser.

---

La mitad conceptual — por qué `attend` y `auto` son opuestos, y el mandato para conducir un
run desde una sesión — está en [Atendido o desatendido](/es/guides/driving). El capítulo
completo, incluidas las cuatro maneras en que una compuerta `agent` se cae hacia una persona,
es
[10 — Unattended mode](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/10-unattended-mode.md).
