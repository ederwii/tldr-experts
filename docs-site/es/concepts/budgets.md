---
title: Presupuestos
---

# Presupuestos

Aquí hay tres ideas, y la segunda toma a la gente por sorpresa.

## 1. Los techos son por run, por fase y por etapa

`tldrx run new pay --budget 25` fija el techo del run. Ese techo se reparte entre las fases
en proporción al costo que cada etapa declara, y se escribe en `budget.yml`. Una etapa que
la fase no alcanza a pagar se **rechaza antes de empezar**, no se detiene a medias.

```
budget  $0.00 spent of $5.00 ceiling ($5.00 left)
> 01-what   [░░░░░] 0/1 stages   $0.00 / $0.80
  02-how    [░░░░░] 0/1 stages   $0.00 / $1.20
```

Cuatro cosas acotan lo que cuesta una sola etapa, y nada más dos actúan *antes* de que se
gaste el dinero. La guía práctica es [Presupuestos y estimaciones](/es/guides/budgets); la
versión corta es que `--max-usd` es la más débil de las cuatro, porque termina un
run solo una vez que ya se conoce el costo de un turno, y no puede detener un turno que va
en vuelo. Medido: una llamada con techo de $1.50 se mató después de haber gastado **$5.15**.

## 2. Hay dos economías, y no se suman

Un turno se puede pagar de dos maneras distintas, y tldrx se niega a fingir lo contrario.

| | quién corre el turno | quién paga | qué se registra |
|---|---|---|---|
| **metered** | el framework lanza Claude Code | tu cuenta de API, por turno | la cifra exacta en dólares que reportó el CLI — y cuando un turno vuelve sin ninguna (por ejemplo, un proceso que se murió antes de escribir su documento de resultado), `cost_usd: null, metered: false` como cualquier otro turno sin medir, nunca un `$0.00` que nadie midió |
| **Codex** | el framework lanza `codex exec` | tu cuenta de Codex | tokens medidos; `cost_usd: null, metered: false` porque el CLI no reporta USD |
| **host** | la sesión de Claude Code en la que ya estás, con sus propios subagentes | el plan de tu sesión | `cost_usd: null, metered: false` |

Un turno host **no tiene medidor propio**. El framework no lo lanzó y nunca le dijeron
cuánto costó, así que registrar `$0.00` sería una medición, y falsa. En vez de eso no
registra nada, y lo dice:

```
  STAGE           ECONOMY       MEASURED     DECLARED
  01-what/what    metered-usd   $1.70        —
  03-plan/plan    host-tokens   —            ~342.5k tokens (host session)

  metered      $1.70 over 1 attempt
```

Si tú sabes lo que costó un turno host, lo puedes declarar: `tldrx next --commit --cost-usd
0.42`. Lo declarado se guarda aparte de lo medido, porque son afirmaciones distintas.

Eso no deja sin límite a una fase host. `budget.yml` acepta un `ceiling_host_tokens`
opcional, a nivel de run y por fase, y los `tokens:` declarados se suman contra **ese**
techo, nunca contra `ceiling_usd`. Los dos nunca se suman ni se convierten: no hay tipo de
cambio entre un dólar medido y un token de sesión host, e inventarlo sería adivinar un
precio. Pasarse del techo avisa; `on_host_tokens_exceed: block` es la opción explícita que
hace que en vez de avisar, niegue. Si no declaras techo de tokens, no hay contra qué
comparar, así que no se revisa nada.

## 3. Un techo no es lo que alguien autorizó

`ceiling_usd` dice lo que el run va a gastar. Nunca ha dicho lo que alguien aceptó pagar. Eso
vivía en prosa — un hecho, un mensaje, un hilo — y nada lo volvía a leer, así que tres lugares
distintos podían escribir un techo en dólares y ninguno le respondía a la decisión que había
detrás.

`tldrx budget grant` escribe esa decisión como un número:

```bash
tldrx budget grant 20 --fact F031
tldrx budget grant 5 --fact F031 --phase 04-build --on-exceed block
```

**Registra**: no gasta nada y no mueve ningún techo. `--fact` es obligatoria y tiene que nombrar
un hecho vivo, porque una autorización que no puede citar una decisión es un número que nadie
dijo. El `<usd>` es un total, no un delta.

Después, `tldrx budget raise` mide el techo que está a punto de escribir contra la autorización,
antes de que se escriba nada: una autorización de fase contra el techo de la fase, la del run
contra el techo del run. Con el valor por omisión `on_grant_exceed: warn` el techo se escribe y
una frase nombra la autorización, el hecho y la cifra; con `block` el `raise` se rechaza y
`budget.yml` queda idéntico byte por byte.

**Dos preguntas distintas, dos llaves distintas.** `on_exceed` gobierna *gastar* por encima de
un techo. `on_grant_exceed` gobierna *escribir* uno por encima de lo autorizado. Un run que
bloquea por dólares no ha dicho nada sobre lo segundo, así que nunca se deduce de lo primero.

Que no haya autorización registrada significa que no se concilia nada y no se rechaza nada. La
ausencia jamás se lee como `$0`: todos los `budget.yml` escritos antes de estas llaves existen,
y tomar su silencio por una autorización de nada rechazaría cada `raise` en todos ellos. Una
segunda autorización sobre el mismo alcance reemplaza a la primera — una decisión posterior
sustituye a una anterior — y dice qué reemplazó, en vez de cambiar el número en silencio.

## Cómo leer la cuenta

```bash
tldrx cost                # este run: por intento, por etapa, por run
tldrx cost --all          # todos los runs del workspace, sumados por economía
tldrx run estimate        # el único que adivina — y lo dice con todas sus letras
```

`tldrx cost` lee el log de eventos del run, y nada más. **Nunca se multiplica un conteo de
tokens por un precio.** Los reintentos jamás se funden en el total de la etapa: una etapa que
falló dos veces costó tres turnos, y ese reintento suele ser justo el dinero que andabas
buscando. Todo aquello de lo que el proceso nunca vio un costo se imprime como `UNMETERED`.

Junto al dinero ahora hay una **duración** por intento, y dice de qué lapso se trata.
`spawned` es el proceso del propio sub-agente, de que arranca a que sale.
`prepare-to-commit` es el hueco entre el `--prepare` que le entregó su paquete a una sesión
anfitriona y el `--commit` que registró el turno — que incluye todo lo que la sesión hizo en
medio, así que es un techo sobre el tiempo del sub-agente y nunca se le llama el tiempo del
sub-agente. Un intento anterior a que el framework registrara cualquiera de los dos se lee
`not recorded`, jamás `0s`.

Y donde sea que aparezca una cifra de gasto — `run status`, `budget show`, el tablero, un
replay, el handoff de Build — un run con turnos sin medir se lee `≥ $12.40 (7 tasks
unmetered)`, o `not measured: 9 in-session tasks, 0 metered` cuando no se midió
absolutamente nada. Un `$0.00` pelado sobre treinta stories que pagó la sesión de alguien es
aritméticamente cierto y comunicativamente falso. Un run que sí midió todo conserva su cifra
de siempre.

`tldrx cost --stories` cambia el eje, no la fuente: una fila por cada story de build, con lo
que costó de forma medible al lado del **techo de spawn** que el ejecutor le entregó a sus
spawns, y la razón entre ambos. Son dos tipos de número distintos — un cobro y un tope —, así
que van en columnas separadas y nunca se suman. A una story a la que le falta uno de los dos
lados le aparece `not recorded` con el motivo, y una medición que incluye un turno sin medir se
nombra como cota inferior en vez de recibir un veredicto.

Cuando el proveedor reporta su propio desglose de tokens de un turno, las dos mitades caen
en la fila de ese turno en `run.yml` — `input_tokens` y `output_tokens`, escritas juntas o
no escritas —, porque un desglose al que le falta un lado no se distingue de uno que nadie
reportó. Son **la procedencia de la cifra en dólares que va al lado**, para que quien lea
después pueda cotejarla contra una tabla de precios en vez de creérsela. No son una segunda
forma de ponerle precio al turno.

`tldrx run estimate` tiene permiso de adivinar, y se etiqueta a sí mismo `ESTIMATE`. La
mitad está medida: el prompt de la siguiente etapa, armado por el mismo código que la
correría. La otra mitad es la mediana de la salida de los intentos pasados en esa etapa, y
sin historia no imprime estimación alguna en lugar de inventarse una.
