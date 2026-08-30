# Auditoría — estado, resumibilidad y concurrencia (2026-08-29, main 4c0e070, CLI global 0.3.0) · 6/10

**tl;dr** — Los ficheros sí resumen: mate lo que mate, `tldrx next` reanuda. El proceso y el dinero no: el sub-agente se lanza `detached` (`bunRuntime.ts:34`) y no hay handler de señales en la ruta de run, así que Ctrl-C deja un `claude` vivo facturando contra su techo sin que nadie registre el gasto (medido). Y el único corte sin `.lock` — morir entre `--prepare` y `--commit` — deja un run que `approve`/`reject`/`--commit` rechazan y que `status` etiqueta como `ready`: el único comando que ofrece vuelve a pagar. (Nota: los importes "medidos" provienen de la fixture `claude` falsa de la suite, no de gasto real — asumido.)

## A · Matriz de resumibilidad
| Corte | En disco | `status`/`next` | Recuperación | ¿Pérdida / doble pago? |
|---|---|---|---|---|
| `next` headless SIGKILL | `.lock` pid muerto, etapa `running`, `agent.spawned` sin `agent.result` | `next` limpia lock caduco, `running`→`ready`, reejecuta | `tldrx next` | sí a las dos: hijo sobrevive (ppid 1), coste nunca anotado (`runNext.ts:371` solo tras retorno) |
| Ctrl-C | idem | idem | idem | único `process.on("SIGINT")` (`ui/driver.ts:191-198`) solo restaura cursor |
| tras `--prepare`, antes de `--commit` | sin `.lock`, etapa `running`, `pending.json` + `prompt.md` | `status`: "ready → tldrx next" (`waiting.ts:28`/`runStatus.ts:48` sin kind `running`) | `--commit`→exit 1 (`pending.ts:129-135`); `approve`/`reject`→exit 2 (`gates.ts:125,165-171`); camino sano no documentado: `result.json` a mano → `--commit` → `reject` | `tldrx next` a secas re-lanza y tira el trabajo pagado |
| `run auto` a media | como fila 1; etapas cerradas firmes | — | `run auto` sin flags | una etapa; nota de lock caduco se traga en exit 0 (`runAuto.ts:134-137`) |
| Build: worktree + DoD corriendo | worktree, ramas `story/S1` + `epic/<slug>`, story `in_progress` (`build.ts:253`) | — | `tldrx next` reanuda y completa | una historia re-lanzada; worktree reutilizado sin avisar (`build.ts:338`) |
| `seed apply` 3 de 8 | 3 run dirs; `split.yml` sigue `proposed` (`applySplit.ts:113-157`) | `apply` → exit 1 | manual: borrar dirs | residuo `tldrx-work/.tmp-<run>-<pid>` (`newRun.ts:214`) |
| `expert train` a media | `knowledge/<area>.md` sin validar, se inyecta igual (`expertKnowledge.ts:95` solo excluye `*.rejected.md`) | como "nunca entrenado" | reejecutar | coste no registrado; cuarentena (`runTraining.ts:397-406`) solo en proceso vivo |
| `interview` | una respuesta a la vez (`runInterview.ts:57-83`) | — | reejecutar, no re-pregunta | lo mejor; ventana `captureAnswers.ts:94→95` → hecho duplicado silencioso |
| `seed triage --propose` a media | solo `inventory.*` | `status`: "nothing pending" | reejecutar | re-cobra entero; `result.raw.json` no lo lee nadie |

## B · Locks y concurrencia
- `.lock` = pid file por run; únicos usuarios `runNext.ts:107,121`. Caduco: `kill(pid,0)`, EPERM = vivo (`Lock.ts:52-60`); demote testeado (`facilitator.test.ts:406-418`).
- Pid reutilizado ⇒ encallado para siempre (medido `pid 1` → exit 2). No hay `unlock`, `--force`, `cancel`; `cancelled` sin escritor (`RunFile.ts:21`).
- `approve`/`reject` solo se frenan por estado de etapa, no por lock.
- Nada protege lo compartido: `budget raise` concurrente exit 0 y revertido por el `next` en vuelo; dos escritores de `facts.yml` acuñaron ambos `F001`.
- Build: rama `story/<id>` (`build.ts:336`) y worktree (`:889-891`) sin id de run; cuatro runs apilaron en `story/S1`/`epic/leaderboard`; el cuarto reutilizó el worktree vivo del tercero.
- Cero tests de concurrencia real.

## C · Atomicidad
- Atómico solo `run new` (temp + revalidación + `renameSync`, `newRun.ts:214-216,351-360`); `facts.yml` se escribe después del rename (`:356`).
- `RunStore.save()` valida (`RunStore.ts:195-205`) pero dos `writeFileSync` planos (`:206-207`); `spent_usd` se re-deriva, los techos no.
- `events.jsonl` append-only real (`EventLog.ts:36-44`), pero `read()` hace `JSON.parse` sin try (`:73-82`): una línea a medias → `replay` pierde todo con exit 0. Lectores tolerantes existen (`attempts.ts:60`, `build.ts:956`).
- `competencies.yml` plano (`competenciesWrite.ts:143,235`).
- Run corrupto no tumba el workspace: `findOpen` salta (`RunStore.ts:110-118`), `status` lo lista con motivo (`runItems.ts:107-125`).

## D · Idempotencia (medido)
`init` 0 created/16 kept (nunca añade preguntas nuevas, `runInit.ts:104-108`); `interview --init` "No open questions"; `seed apply` exit 1; `approve` exit 2 (gate fallido añade `check.failed` por reintento, `gates.ts:48-61`); `answer` exit 3; `expert recompute` `written:false` (1ª vez tras init siempre escribe por `\n` final, `:87-90`); `install --claude` 0 added/8 there, 0 backups extra; `run new` exit 1 (id es UTC — mismo slug otro día = run distinto); `map --refresh` diff limpio, no emite `map.refreshed` pese a spec §3.

## E · Eventos como historia
`run.yml` es la fuente de verdad; no existe reconstrucción desde eventos (`replay/loadRun.ts:39`). `run.created` no lleva plan por etapa ni experto ni `gates_policy`. Split-brain: contador de review se deriva del ledger (`build.ts:945-960`) → perder `events.jsonl` reinicia `MAX_ATTEMPTS`. `map.refreshed` en enum y renderer, nadie lo emite; `claude --resume <session_id>` (spec §5:1438) no existe.

## F · Huecos por severidad
1. Ctrl-C/kill orfana un sub-agente facturando → handler SIGINT/SIGTERM en `src/cli/index.ts` + `killProcessTree` + `agent.result` parcial; detach en `runtime/bunRuntime.ts:34`.
2. `running` sin `.lock` (prepare huérfano) → rama `running` en `runNext.ts` (~:174-191) que detecte `pending.json` y ofrezca `--commit`/`reject`; kind `running` en `run/waiting.ts:28`.
3. Ramas/worktrees de Build sin id de run → `build.ts:336,889-891`: prefijar con run; refusar si `branchExists` y no es de este run.
4. Sin lock de workspace → `RunStore.ts:191-210` y `FactsStore.save`: read-modify-write bajo lock o CAS por mtime.
5. Sin salida de run encallado → `tldrx run unlock` / `tldrx run cancel`.
6. `RunStore.save()` temp+rename (`RunStore.ts:206-207`).
7. Línea rota borra el historial (`EventLog.ts:73-82`).
8. `map.refreshed` nunca se emite; `--resume` no existe.

**6/10**: (1) recuperación de estado funciona con un comando; (2) no para proceso ni dinero; (3) nada guarda lo compartido. Arreglos 1, 2, 5 son pequeños y suben a 8.
