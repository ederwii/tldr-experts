---
title: Resumen de la CLI
---

# Resumen de la CLI

La autoridad es tu propia máquina: `tldrx --help`, y `tldrx <command> --help` para ver las
banderas de un comando, sus valores permitidos, ejemplos y códigos de salida. Esta página
es un mapa de la superficie, no una copia de ella.

Todos los comandos de aquí abajo se verificaron corriendo su `--help` sobre `main`. Para la
versión exhaustiva — cada bandera, cada rechazo — ver
[8 — CLI reference](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/08-cli-reference.md)
en el repo.

## Los cinco que de verdad vas a escribir

```bash
tldrx init                  # detecta el workspace, mapea el código, pregunta solo los huecos
tldrx run new <slug> --scope feature --budget 25
tldrx next                  # corre la siguiente etapa; se detiene en una compuerta
tldrx answer Q1 "…"         # contesta lo que preguntó
tldrx approve --note "…"    # firma la compuerta; antes se vuelven a correr las verificaciones
```

## Poner todo en marcha

| Comando | Qué hace |
|---|---|
| `tldrx doctor` | Revisa el entorno local. Es la autoridad sobre lo que hace falta. |
| `tldrx init` | Detecta repos, arma el mapa de código, escribe `.tldrx/`, lista los huecos. Offline. |
| `tldrx interview --init` | Contesta las preguntas de configuración en la terminal. |
| `tldrx install --claude` | Escribe la skill `/tldrx`, los hooks y la status line dentro de `.claude/`. |
| `tldrx learn` | El tutorial jugable en sandbox. Sin llave, sin red, $0.00. |
| `tldrx update` | `npm i -g tldr-experts@latest`, más el CHANGELOG entre la versión que tenías y la que quedó. Además, cualquier comando te avisa en una línea cuando ya hay una más nueva: fuera del camino caliente, cacheada, muda si falla la red, y nunca en `--json` ni dentro de un hook. `TLDRX_UPDATE_CHECK=off` lo apaga en una terminal; `update_check: off` en `~/.tldrx/config.yml`, en toda la máquina. |
| `tldrx status` | Todo lo que en este workspace espera a una persona, y el comando para cada cosa. |

## Manejar un run

| Comando | Qué hace |
|---|---|
| `tldrx run new <slug>` | Abre una pieza de trabajo. `--scope`, `--budget`, `--seed`, `--gates`, `--attended-by host`. |
| `tldrx run status [<run>]` | Dónde va, qué está esperando, cuánto costó. `--json`. |
| `tldrx next [<run>]` | Corre la siguiente etapa. `--dry-run`, `--prepare`/`--commit`, `--review`, `--effort`, `--max-reads`. |
| `tldrx run auto [<run>]` | Llama a `next` una y otra vez hasta que algo te necesite. `--max-usd`, `--until`, `--parallel`. |
| `tldrx run attend host \| --none` | Entrega el run a una sesión host, o recupéralo. |
| `tldrx run estimate` | El único comando que adivina. Lo dice: `ESTIMATE`. |
| `tldrx run unlock` / `run cancel` | Limpia un lock viejo; cierra un run para siempre. |

## Decidir

| Comando | Qué hace |
|---|---|
| `tldrx approve` | Firma la compuerta. `--note`, `--as-agent`, `--evidence`. |
| `tldrx reject --note "…"` | Regresa la etapa; `--stage <phase>/<stage>` revoca una firma ya dada. |
| `tldrx gate template` | Escribe el esqueleto de la nota de evidencia sobre la que firma una compuerta agent. |
| `tldrx run gates set <stage>:<policy> --note "…"` | La única manera sancionada de cambiar la política de compuertas después de `run new`. |
| `tldrx questions cards` | Las preguntas ABIERTAS del run como tarjetas de decisión imprimibles: contexto, lo que los documentos ya deciden, las opciones. Solo lee. |
| `tldrx questions lint` | Nombra cada bloque de pregunta que el parser no alcanza a ver: un `## Qn · Título` mal escrito se lee como *ausente*, así que todo lo que viene después reporta "0 preguntas abiertas" y una compuerta auto firma encima. `--fix` los reescribe a la gramática sin cambiarles una palabra. |
| `tldrx answer <Qid> "…"` | Registra una respuesta como hecho numerado. `--supersede` revierte una. |
| `tldrx interview` | Contesta en la terminal las preguntas abiertas de un run. |
| `tldrx story reopen <id> --note "…"` | Le da a una story de Build otra tanda de intentos. `--for-fix` abre en cambio una ronda de arreglo sobre una story que ya está `done`: un defecto concreto, sin consumir intento, con el mismo DoD y el mismo revisor. |

## Dinero

| Comando | Qué hace |
|---|---|
| `tldrx cost [<run>]` | Lo que de verdad se cobró, por intento. `--all`, `--json`. |
| `tldrx budget show` | Lo que al run le queda por gastar. |
| `tldrx budget raise <phase> <usd>` | Mueve un techo. `--take-from <phase>`, `--note`. |

## Conocimiento, salida y lo demás

| Comando | Qué hace |
|---|---|
| `tldrx map --refresh \| --check` | Reconstruye el mapa de código, o revísalo contra el código para detectar desfases. |
| `tldrx expert list \| create \| train \| recompute` | Ver [Expertos](/es/guides/experts). |
| `tldrx seed triage` / `seed answer` / `seed apply` | Parte un documento grande en varios runs. |
| `tldrx watch list \| check [<feature>]` | Las tarjetas de vigilancia que produjo un run: listadas, o impresas como la checklist de post-merge y revisadas contra el código de hoy. `--execute` vuelve a correr los comandos que registraron las tarjetas, a través de la lista blanca del workspace. |
| `tldrx watch arm` | Espera a que el PR del run se mergee y entonces imprime esa checklist. Un poller acotado en primer plano sobre `gh pr view`, no un demonio. |
| `tldrx plan sync-dod \| schema` | Repara los DoD de las stories después de editar `workspace.yml`, o imprime el contrato de story/épica/waves que hace cumplir la verificación `plan`. |
| `tldrx dashboard` | Mira el workspace en vivo en el navegador, o exporta una página estática. Ver [Dashboard](/es/reference/dashboard). |
| `tldrx replay [<run>]` | El log de eventos del run, contado como historia. |
| `tldrx retro` | Cierra un run y captura lo que se aprendió. |
| `tldrx retro --all` | Solo lectura, sobre TODOS los runs: qué clases de hallazgo te siguen agarrando, con conteos y un ejemplo citado de cada una. `--json` para la forma que lee una máquina. No escribe nada. |
| `tldrx drive --attended \| --unattended [<run>]` | Imprime el mandato de sesión para manejar un run: el protocolo de tres papeles, la disciplina de evidencia, qué apartar, con cuánto rigor revisar y honestidad de presupuesto. Llena cada `<run>` con el id, o con el único run abierto. No necesita workspace. |
| `tldrx ship` | Abre un PR desde la rama de la épica, con el handoff como cuerpo: un PR por repo cuando la rama está en varios, listados al final. Si lo vuelves a correr, se salta el repo cuyo PR ya está abierto. |
| `tldrx tickets` | Refleja épicas y stories en una herramienta de tickets. Los archivos siguen siendo la fuente de verdad. |
| `tldrx note <run> "…"` | Registra una anotación del operador, sin cambiar nada más. |

## Códigos de salida

| | |
|---|---|
| `0` | ok |
| `1` | error de uso o de esquema, o una verificación corrió y falló |
| `2` | rechazado — una compuerta dijo que no, o hay varios runs abiertos y no va a adivinar |
| `3` | no encontrado — no hay workspace, no hay run, no hay tarjeta con ese nombre |
| `4` | **esperando a una persona** — la etapa corrió y se detuvo en su compuerta |
| `5` | el subagente falló |
| `130` | Ctrl-C — se mató al subagente y la etapa volvió a `ready` |

Cuáles de estos puede devolver un comando dado te lo dice `tldrx <command> --help`.

## Dos convenciones que aplican en casi todos lados

- **Nunca adivina a qué run te referías.** Con varios abiertos y sin id, un comando que
  apunta a un run sale con `2` y te los lista. Pásale un `<run>` posicional en `next`,
  `run status`, `cost`, `replay` y `retro`; `--run <id>` en los demás.
- **La salida de progreso siempre va a stderr.** `--ui scene|compact|plain|off` (por
  omisión `auto`) cambia lo que ves mientras corre un subagente; stdout queda idéntico byte
  por byte en cualquier caso, así que `tldrx run status --json | jq` no se ve afectado.
