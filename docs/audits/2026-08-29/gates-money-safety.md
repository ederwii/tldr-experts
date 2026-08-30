# Auditoría — gates, dinero y seguridad (2026-08-29, main 4c0e070, solo lectura) · 6/10

**tl;dr** — La ingeniería es sólida (sin shell en adapters, sin `push`, dashboard en loopback, `install` no toca `permissions`). El fallo está en el *significado* de las barreras: un handoff enteramente fabricado cierra la puerta automática y ya no se puede revocar (probe medido). Y el `dod` corre `sh -c` con una cadena escrita por el modelo.

## A · Dinero
| Sitio | Techo | Suelo | Nota |
|---|---|---|---|
| `next` | `min(stage×share, per_agent_max, --max-usd)` `runNext.ts:1002-1004` | $0.01 `spawnAgent.ts:158` | — |
| `run auto` | `--max-usd` entre etapas `runAuto.ts:112-116`; 96 iter | — | rebasa ≤1 etapa |
| Build | dev 1/N `build.ts:849` + rev 0.25/N `:853`, ×2 intentos `:55` | ninguno | 2.5× el techo de fase |
| Watch | share=cap/N sin tope agregado | $0.25 `watch.ts:298-299` | N×0.25 puede superar el techo |
| `expert train` | $2.00 `Training.ts:32` | $0.25 | |
| `seed triage --propose` | $1.00 `runTriage.ts:51` | $0.25 | |
| `run new --from/--seed` | $0 | — | determinista |

- `--max-budget-usd` = parar tras el turno (medido $5.15 vs $1.50, `spec.md:717-720`). Peor caso `run auto` feature: cadena auto build+watch = $11 declarados → ~$76 reales (2.5× Build × 3.4× spawn, inferido). Programa 8 runs: $200 declarados, sin tope agregado ni comando que los sume.
- ¿Gasto sin que un humano vea un número? Sí: `run new --gates none` (`gatePolicy.ts:93`) + `run auto`. El hook `budget-gate` solo casa `^(claude -p|tldrx next)\b` (`budget-gate.ts:31`) — no cubre `run auto`/`expert train`/`seed triage` — y falla abierto (`:14`).
- Reconciliación real del envelope `total_cost_usd` (`spawnAgent.ts:119` → `runNext.ts:364`); JSON ilegible ⇒ $0 silencioso; en `--commit` el coste lo declara la sesión anfitriona (`runNext.ts:610`, `pending.ts:150`). No existe agregado multi-run ("program" no aparece en `src/`).

## B · Auto gates — lo que se cuela
Probe medido: handoff con `[src: F999]`, `[src: Q42]`, `[src: graph:i-made-this-up]`, `[src: absent:ops/backup.yml]` afirmando "quitamos el auth de /admin" → `claim-sources:passed`, `gate.by = "auto"`, cursor avanza.
- `resolveSrc` devuelve `ok:true` por defecto para `fact`, `answer`, `graph`, `doc`, `absent`, `aidlc` — 6 de 8 tipos son escudos (`srcToken.ts:240-246`). Solo `file` y `cmd` se comprueban; `cmd` solo pertenencia, no ejecución.
- `[unverified]` no existe en el validador. Cero preguntas = condición cumplida (`questions.md` inexistente ⇒ `[]`, `autoGate.ts:150`).
- El fixture del repo usa el patrón escudo (`test/fixtures/facilitator/workspace.ts:213-228`).
- DoD: si `workspace.yml` no declara `commands:`, cualquier comando es legal (`schemas/story.ts:159`).
- `by: auto` visible en `run.yml`, evento y `run status`; NO en `tldrx status` ni statusline.
- Revocar: NO. `approve()` mueve el cursor en la misma transacción (`gates.ts:63-77`); `reject` solo actúa sobre el cursor, sin `--stage` (`gates.ts:161`, `reject.ts:26`). Probe: `REJECT REFUSED: nothing to reject: 02-how/beta is 'ready'`.

## C · Acciones destructivas
- Build verificado: worktree `.tldrx/worktrees/<repo>/<story>` (`build/plan.ts:29-30`), rama `story/<id>` desde `epic/<slug>`, ningún wrapper de `push` (`build/git.ts:13`), merge `--no-ff` con `--abort` (`git.ts:142-155`), cwd dentro de repo declarado.
- `--yolo` = `--dangerously-skip-permissions` (`spawnAgent.ts:89`) en `next`/`run auto`/`seed triage`/`expert train` — y se pasa también al revisor "read-only" (`build.ts:477`).
- RCE local desde el framework: `runDodCommand` ejecuta `/bin/sh -c <cadena del modelo>` (`hooks/lib/story.ts:73`); `dod-gate.ts:56-74` nunca contrasta con la allowlist; instalado por defecto como PreToolUse, timeout 960 s (`managedEntries.ts:66-75`). Una story con `dod: rm -rf ~` se ejecuta al marcarla done.
- `touches` no se aplica (solo prompt, `prompts.ts:84`); `commitAll` hace `git add -A` (`git.ts:123`).
- Tickets: `gh issue create|edit` argv sin shell (`github.ts:45-46`), Jira POST/PUT; `--dry-run` NO es default (`tickets.ts:89`); `--provider` salta `kind: none` (`tickets.ts:175-183` vs `spec.md:782`). Ningún test toca red.

## D · Secretos y datos
- A Anthropic: prompt entero por stdin (facts, knowledge, inputs). A GitHub/Jira: solo título + acceptance + test_plan + ruta (`body.ts:34-56`).
- Dashboard `127.0.0.1` fijo (`server.ts:36,70`), 3 rutas exactas; sin auth ni chequeo de `Host` ⇒ DNS-rebinding a `/model.json` (inferido).
- En disco: `.agent/prompt.md` y `result.raw.json` completos, cubiertos por el `.gitignore` de init. `events.jsonl` guarda la respuesta humana literal (`captureAnswers.ts:80`) y va a git.
- Huecos de gitignore: `.claude/settings.json.bak-tldrx-*` (`installClaude.ts:318`); el propio repo no lleva su bloque.
- `install --claude`: solo `hooks` y `statusLine` (`mergeSettings.ts:46,69,80`), backup antes, idempotente, `--uninstall` es unmerge y nunca restaura el `.bak`.

## E · Override humano y traza
- `gate.approved` lleva `by` + `note` (`gates.ts:84-89`). Log append-only sin hash. `budget raise` no emite evento (`budget.ts:77-84`). No hay pánico: ni `park`, `cancel`, `abort`, `unlock`; `cancelled` sin escritor. Lock: pid muerto se recupera; pid vivo colgado no tiene salida. `actor` = `$USER`; `--note` vacío admitido.

## F · Gaps priorizados
1. `dod` por `sh -c` sin allowlist cuando `commands:` está vacío → `schemas/story.ts:159`, `hooks/dod-gate.ts:56`
2. `claim-sources` no verifica 6 de 8 tipos ⇒ 5.ª condición del auto-gate decorativa → `srcToken.ts:240-246`, `autoGate.ts:137`
3. Aprobación auto irreversible → `gates.ts:63-77`, `reject.ts:26` (falta `--stage`)
4. `--yolo` llega al revisor → `executors/build.ts:477`
5. `budget-gate` no cubre `run auto`/`train`/`triage` y falla abierto → `budget-gate.ts:31,14`
6. `budget raise` sin evento; sin agregado multi-run → `budget.ts:77`, `Event.ts:8`
7. `tickets sync` escribe en vivo por defecto; `--provider` salta `none` → `tickets.ts:89,175-183`
8. Build 2.5× su fase; Watch supera techo por suelo → `build.ts:55,849,853`, `watch.ts:298`
9. `.bak-tldrx-*` no ignorado → `ambientFootprint.ts:15`
10. Dashboard sin chequeo de `Host` → `dashboard/server.ts:130`

**6/10**: (1) medido — handoff inventado se auto-aprueba y no se puede rechazar; (2) medido — `sh -c` sobre cadena del modelo con hook por defecto; (3) medido — el resto bien defendido (1084 tests, argv sin shell, sin push, loopback, coste reconciliado real). Arreglar 1–3 lo pone en 8.
