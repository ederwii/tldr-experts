---
title: Preguntas frecuentes para impacientes
---

# Preguntas frecuentes para impacientes

## ¿Cuál es la forma más corta de entender esto?

`tldrx learn`. Ocho capítulos, quince minutos, un sandbox desechable, sin llave de API,
$0.00, y cada comando ahí dentro es el binario de verdad.

## ¿Puedo manejarlo desde Claude Code? {#puedo-manejarlo-desde-claude-code}

Sí, y es la manera más agradable.

```bash
tldrx install --claude    # escribe .claude/skills/tldrx/ y mezcla los hooks y la status line
```

Después escribe **`/tldrx`** en ese proyecto. Corre `tldrx status`, encuentra lo que ya te
está esperando — preguntas de configuración sin responder, un run detenido en una
compuerta, un experto en el que ninguna etapa se puede apoyar todavía — y te lleva de uno
en uno, preguntándote cada decisión que te toca y corriendo nada más los pasos mecánicos.

No necesitas Claude Code. Cada comando es un CLI y cada hook es un script que lee JSON de
stdin. `tldrx install --claude --uninstall` quita exactamente lo que escribió.

## ¿Hace commit? ¿Hace push?

Build hace commits — en una rama propia, uno por story, mergeados a una rama de épica.
**Nunca hace push.** La rama de la épica te espera a ti, y el merge final es tuyo.
`tldrx ship` abre un PR desde ella cuando tú quieras.

## ¿Cuánto cuesta de verdad un run?

Un run de scope `feature` trae un techo por omisión de $25; uno de `spike`, $6. En un
workspace real una etapa What midió entre $1.20 y $1.40. No se cobra nada hasta que corres
una etapa, y `tldrx next --dry-run` te enseña el prompt y el techo sin lanzar nada. Ver
[Presupuestos y estimaciones](/es/guides/budgets).

## ¿Mi código se manda a algún lado?

`tldrx init`, `run new`, `answer`, `approve`, `status`, `cost` y `learn` son offline: nada
más sistema de archivos y git. `tldrx next` manda un prompt ya armado al modelo, como
cualquier otra herramienta de programación con IA. Lo que va en ese prompt no es un
misterio: `tldrx next --prepare` lo escribe a un archivo e imprime su desglose byte por
byte antes de lanzar nada.

## ¿Cómo lo mantengo actualizado?

`tldrx update`: es `npm i -g tldr-experts@latest` corrido por ti, e imprime el CHANGELOG
entre la versión que tenías y la que quedó, leído de vuelta de lo que npm instaló y no
supuesto. Además, cualquier comando te avisa en una línea cuando ya existe una versión más
nueva: nunca se llama al registro en el camino caliente, la respuesta se cachea por un día,
y jamás aparece en la salida `--json` ni dentro de un hook. `TLDRX_UPDATE_CHECK=off` lo
calla en una terminal; `update_check: off` en `~/.tldrx/config.yml`, en toda la máquina.

## ¿Cómo lo detengo?

Ctrl-C. Mata el árbol de procesos completo del subagente, registra un resultado parcial con
`cost_usd: null` y `stopped_by: signal`, regresa la etapa a `ready`, suelta el lock y sale
con `130`. Corre `tldrx next` otra vez y reintenta esa etapa.

Si un comando se murió feo y dejó un lock tirado: `tldrx run unlock`.

## Me dijo "3 runs are open — pass one" y se negó

Eso es que está funcionando. Con varios runs abiertos y sin id, un comando que apunta a un
run te los lista y se niega en lugar de adivinar a cuál te referías — sale con `2`, salvo
`cost`, que se niega con `1`. `run status` es el que no se niega: te los lista y sale
con `0`, así que ahí es donde vas a buscar el id. Pásale el id.

## ¿Y si no estoy de acuerdo con lo que hizo?

```bash
tldrx reject --note "…"                    # regresa esta etapa; la nota le llega al siguiente intento
tldrx reject --stage 02-how/how --note "…" # revoca una aprobación ya dada
tldrx story reopen S3 --note "…"           # solo esta story de Build
tldrx story reopen S3 --for-fix --note "…" # un defecto concreto en una story ya terminada
tldrx run cancel --note "superseded"       # cierra el run para siempre; no se borra nada
```

## ¿Qué significan los códigos de salida?

| | |
|---|---|
| `0` | ok |
| `1` | error de uso o de esquema, o una verificación corrió y falló |
| `2` | rechazado — una compuerta dijo que no, o no quiere adivinar entre varios runs |
| `3` | no encontrado — no hay workspace, no hay run, no hay tarjeta con ese nombre |
| `4` | **esperando a una persona** — la etapa corrió y se detuvo en su compuerta. No es una falla. |
| `5` | el subagente falló |
| `130` | Ctrl-C — se mató al subagente y la etapa volvió a `ready` |

## ¿Tengo que hacer commit de `.tldrx/` y `tldrx-work/`?

Sí, ese es el diseño. [Los archivos son el estado](/es/concepts/files-as-state), así que
quien clone el repo se lleva el run.

## ¿Ya está listo?

**Beta, 0.4.0.** Todos los comandos son reales y están probados; la autoridad es
`tldrx --help` en tu máquina, no este sitio. Las versiones hasta la 0.3.1 fueron `alpha`; la
0.4.0 es la primera `beta`, y el requisito para llegar ahí ya se cumplió: formatos de
archivo congelados, dos o más workspaces reales llevados hasta Build, y una ruta de
actualización documentada.

## ¿Puedo contribuir?

En [`CONTRIBUTING.md`](https://github.com/ederwii/tldr-experts/blob/main/CONTRIBUTING.md)
está el recorrido que hace un cambio, las cuatro compuertas y lo que CI de verdad corre, las
reglas de prueba-en-rojo-primero, y por dónde entraría un proveedor de modelo externo.

## Algo se está negando y no sé por qué

`tldrx status` dice qué está esperando por ti e imprime el comando para cada cosa. Más allá
de eso,
[9 — Troubleshooting](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/09-troubleshooting.md)
lista todos los rechazos que el framework puede emitir y el movimiento que destraba cada uno.
