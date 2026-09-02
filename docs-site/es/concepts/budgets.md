---
title: Presupuestos
---

# Presupuestos

Aquí hay dos ideas, y la segunda toma a la gente por sorpresa.

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
| **metered** | el framework lanza Claude Code | tu cuenta de API, por turno | la cifra exacta en dólares que reportó el CLI |
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

## Cómo leer la cuenta

```bash
tldrx cost                # este run: por intento, por etapa, por run
tldrx cost --all          # todos los runs del workspace, sumados por economía
tldrx run estimate        # el único que adivina — y lo dice con todas sus letras
```

`tldrx cost` lee las cifras en dólares del log de eventos del run, y de nada más. **Nunca
se multiplica un conteo de tokens por un precio.** Los reintentos jamás se funden en el
total de la etapa: una etapa que falló dos veces costó tres turnos, y ese reintento suele
ser justo el dinero que andabas buscando. Todo aquello de lo que el proceso nunca vio un
costo se imprime como `UNMETERED`.

`tldrx run estimate` tiene permiso de adivinar, y se etiqueta a sí mismo `ESTIMATE`. La
mitad está medida: el prompt de la siguiente etapa, armado por el mismo código que la
correría. La otra mitad es la mediana de la salida de los intentos pasados en esa etapa, y
sin historia no imprime estimación alguna en lugar de inventarse una.
