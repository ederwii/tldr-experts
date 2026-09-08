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
[`tldrx drive`](/es/guides/driving) escribe un mandato.

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

### Los ocho tipos

El conjunto es cerrado — un tipo que llegara de la nada sería una rama que nadie escribió —
así que un `switch` sobre `kind` con un `default` es un adaptador completo.

| tipo | cuándo dispara | qué lleva `command` | `detail` |
|---|---|---|---|
| `question.raised` | el bucle se detuvo en una pregunta abierta | la línea `tldrx answer` de la primera pregunta | `questions[]` — `id`, `title`, `why_asked`, `options[]` como `{letter, text}`, `recommendation` (`option`, `why`, `src`) o `null`, `answer_command` |
| `question.timeout` | se venció `--wait-answers` y el bucle está por salir con `4` | la misma línea de respuesta | los mismos `questions[]`, más `waited_ms` |
| `gate.requested` | una etapa terminó y una persona tiene que firmarla | `tldrx approve --run <id>` | `cost_usd`, `approve_command`, `reject_command` |
| `stage.done` | una etapa terminó y el bucle siguió | `null` — el bucle ya está corriendo la siguiente etapa | `cost_usd` |
| `run.finished` | el bucle terminó con salida `0` | `null` | `exit_code`, `exit_family`, `spent_usd` |
| `run.failed` | el bucle terminó con cualquier salida distinta de cero, rechazos incluidos | `tldrx run status <id>` | `exit_code`, `exit_family`, `spent_usd` |
| `budget.warned` | un techo está cerca | `tldrx budget show --run <id>` | `spent_usd`, `ceiling_usd` |
| `status` | cada `--notify-every <duration>` mientras el bucle corre | `tldrx run status <id>`, o la línea de respuesta cuando está detenido | `status_text` — lo que imprime `tldrx run status`, textual — y `waiting_on`, los ids de las preguntas abiertas que lo detienen (`[]` si no hay) |

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
tldrx run auto 260907-checkout --notify-every 10m --wait-answers 30m
```

Las dos banderas toman una **duración**: `30s`, `10m`, `2h`, o un número pelado de segundos.
Un valor que no sea una duración se rechaza con salida `1`.

- **`--notify-every <duration>`** agrega la carga `status` periódica. Apagada por defecto, y
  no hace absolutamente nada si no hay un comando `notify:` declarado. Existe porque el rato
  en el que más quieres saber que un run sigue vivo son los veinte minutos que pasa dentro de
  una etapa.
- **`--wait-answers <duration>`** es la única bandera que cambia dónde se detiene el bucle.
  En vez de salir con `4` apenas una etapa se detiene en una pregunta abierta, consulta los
  archivos de preguntas del run durante ese rato y **retoma solo** si alguien responde. No se
  gasta nada mientras espera. Cuando el plazo se vence manda un `question.timeout` y entonces
  **sale con `4`** con las mismas líneas de siempre: el run queda intacto, no se perdió nada,
  y `tldrx run auto` lo retoma en cuanto la pregunta esté respondida.

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

1. **Declara `test_fast`** en `.tldrx/workspace.yml`: el subconjunto rápido sobre el que
   itera el developer de Build. No es un comando de Definition of Done; el DoD vuelve a
   correr `test:`.
2. **Escribe el adaptador y decláralo** bajo `notify:`. Empieza con todos los tipos y
   angosta `events:` después, cuando ya sepas cuáles quieres que de verdad te despierten.
3. **Prueba el adaptador a mano**, antes de que ningún run dependa de él:

   ```bash
   echo '{"version":1,"kind":"status","at":"2026-01-01T00:00:00Z","run":"demo","root":"'"$PWD"'","stage":null,"summary":"hello","command":null,"detail":{"status_text":"hello","waiting_on":[]}}' | bin/notify-owner
   ```

   Si eso no te llega, nada te va a llegar.
4. **Lanza primero con un intervalo corto** — `--notify-every 60s` para una etapa — para
   enterarte de que el hook funciona mientras sigues frente al teclado. Después súbelo.
5. **Mira `tldrx run status`** para la vista del propio run, y `tldrx replay <run>` para el
   registro de eventos como relato, `notify.sent` / `notify.failed` incluidos.

## Cuando algo no sale

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
