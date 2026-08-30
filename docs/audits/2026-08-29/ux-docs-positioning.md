# Auditoría — UX, docs y posicionamiento (2026-08-29, medido contra global 0.3.0 @ 4c0e070, reverificado en ef72fc8)

**tl;dr:** el núcleo del CLI es mejor que su etiqueta alfa (`run status`, `doctor`, `events.jsonl`, los gates). Falla el envoltorio: hoy el producto no se puede instalar (npm 404, sin tag `v0.3.0`), la doc creció ~70% en un día, y el gate insignia tiene un falso positivo que rompe el primer run.

Método/honestidad: el auditor ejecutó `tldrx next` creyendo que era inocuo → gastó $0.40 (produjo el hallazgo #5). Retirado: 95 s de silencio en `next` — wave K lo arregla.

## A. Primeros 15 minutos — 40 conceptos, y el primer run falla
Bueno: `doctor` 15 líneas con veredicto; `init` 0,54 s, 28 líneas, sin modelo; errores pre-init nombran el remedio; `run status` 20 líneas con barras, presupuesto, gates y `waiting` con el comando exacto; `init-handoff.md` etiqueta measured/inferred/assumed con `[src]` incl. `absent:`.
Malo:
1. `npm i -g tldr-experts` → 404 (unpublished 2026-08-29T06:33Z); `git tag -l` sin `v0.3.0`. Mata README:3,21,33.
2. `tldrx status` recién inicializado: 44 líneas, 7 ítems, 1 accionable; [2]–[6] "has to wait for a finished stage"; "an untrained expert reads like a trained one" ×5.
3. Doc y CLI se contradicen sobre cómo contestar el init: README:170 "use `tldrx interview --init` rather than editing" vs `init.ts:126` "then answer .tldrx/init-questions.md" y `src/core/init/questions.ts:176` "Answer any subset by writing after `[Answer]:`".
4. 40 de 50 conceptos sondeados en los primeros 7.337 caracteres. Esenciales: 6 (run, stage, gate, budget, handoff, `[src:]`). Ocultables: level/competency/star chart/train, role vs stack vs domain, prepare/commit, provider, cursor, task, watcher, mirror-out.
5. Bug: `TRAILING_TOKEN_RE = /\[src: ([^\]]*)\]$/` (`srcToken.ts:71`) anclado a `$` → `` `[src: …]` `` con backticks, `[src: …].` con punto o entre paréntesis → NULL → "unsourced". 9/9 balas llevaban cita; el mensaje miente ("sin fuente" cuando es formato). Primer muro del usuario nuevo.

## B. Docs — acreción, no arquitectura
- README 694 líneas, 22 H2, 1 H3; tres quick-starts (`Start here` L18, `Quick start` L30, `The loop, in five lines` L130); `## Budgets` en L666; `## What actually works today` es un changelog. ~74% del README tiene un día.
- CHANGELOG 854 líneas; `0.3.0 — unreleased` = 545; 17 `###` estilo blog, ninguno Keep-a-Changelog; cinco hablan de training; sigue "unreleased" con `package.json` 0.3.0.
- `docs/spec.md` 1.714 líneas: changelog con numeración de spec; 0 MUST/SHOULD/MAY vs `never` ×47; `spec.md:10` "Every schema's first key is `version: 1`" es FALSA: 7 de 8 templates abren con `schema_version: 0`.
- ROADMAP: "shipped in 0.3.0" ×4 mientras `release-check.sh:13` rechazaría 0.3.0.
- concept.md: el único con "por qué"; usa el nombre retirado `fw` ~7 veces; §17 "Open questions" respondida 30 líneas después.
- SKILL.md (149 líneas): lo mejor escrito; única pieza que lista los 13 scopes.
Contradicciones doc↔código (12 comprobadas, 7 fallan): README:170 vs init.ts:126 y questions.ts:176; SKILL "expert item con command VACÍO" (medido 0 vacíos); `replay --help` `<run-id>` obligatorio (sin id → exit 0); `stages/how/stage.yml:44` `gate.requires:` decorativo (`workflowPreset.ts:216` solo lee `.type`); README lista `dashboard` en "refuses on ambiguity" vs `spec.md:1054` lo exime; `spec.md:10` vs templates; "781 tests" no verificable (979 `test(`/`it(`).

## C. CLI — 5 peores papercuts
1. `--help` por comando = solo la línea de uso: sin flags, sin ejemplos, sin exit codes; `--scope <s>` no dice que hay 13 valores y el error tampoco los lista.
2. Flags desconocidos se ignoran en silencio (`tldrx status --nope` → exit 0).
3. `--json` con tres comportamientos: soportado; aceptado-e-ignorado (`doctor`, `watch list`, `tickets status`); rechazado (`map --check`).
4. Exit codes coherentes por dentro (`src/cli/exitCodes.ts` 0/1/2/3/4/5/64), invisibles por fuera; comando inexistente → 64 (`EXIT_NOT_IMPLEMENTED`); 1 y 64 = usage; 2 = "falta id" y "gate rechazado".
5. Objetivo del run inconsistente: posicional en `next`/`run status`/`retro`/`replay`, `--run` en el resto; `map --refresh` vs `watch list`; `tldrx status` vs `tldrx run status`.

## D. Posicionamiento
Tiene (en código): evidencia obligatoria en 3 puntos (`claim-sources.ts:58` hook, `checks.ts:71` approve, `runNext.ts:665` next), `[src: file:line]` stat-eado (`srcToken.ts:223`); `dod-gate` re-ejecuta y falla cerrado; escalera aritmética (`competencyLevel.ts:87`); presupuesto como negativa en 3 capas; gates/scopes como datos; cero deps, 36k LOC.
Falta: `const CLAUDE_BIN = "claude"` (`spawnAgent.ts:19`) sin adaptador → no multi-modelo; cero paralelismo (`executors/build.ts:17`; `waves.yml` describe y nadie ejecuta); cero evals de calidad (979 tests prueban el arnés, ninguno el resultado); autor único, sin comunidad/sitio/runners/GUI; Linear en enum sin implementar.
| Competidor | Quién gana |
|---|---|
| AWS AI-DLC | AI-DLC en empresa con auditoría multi-persona; tldrx si quieres que las afirmaciones se rechacen solas |
| GitHub Spec Kit | Spec Kit en adopción/GitHub; tldrx en resumabilidad y gasto |
| BMAD | BMAD en comunidad y roles listos; tldrx en nivel de experto verificable |
| Kiro | Kiro en IDE; tldrx fuera: terminal, CI, chat |
| Plan mode + subagents | nativo para cambios de un día; tldrx cuando el trabajo dura más que el contexto |
| Aider | Aider en edición rápida multi-modelo; tldrx en fases con gates |
| OpenHands/Devin | ellos en autonomía/paralelismo/hosted; tldrx en trazabilidad y coste acotado |
5 movimientos a 6 meses: (1) republicar npm + congelar superficie (horas); (2) arreglar `TRAILING_TOKEN_RE` + mensaje (1 día); (3) suite de evals: 10 repos semilla, tldrx vs `claude -p` desnudo en DoD verde/coste/reintentos (3–6 semanas) — lo único que convierte "tiene gates" en "produce mejor software"; (4) capa de proveedor tras `spawnAgent.ts` (4–8 semanas); (5) ejecutar `waves.yml` en paralelo en Build (2–4 semanas).

## E. Puntuaciones: UX/docs 5/10 · posicionamiento 6/10
Arreglos por retorno: 1 republicar + tag + badge (`README.md:3,21,33`); 2 regex + mensaje (`srcToken.ts:71`); 3 "Next:" → `interview --init` (`init.ts:126`, `init/questions.ts:176`); 4 `status` colapsa expertos sin evidencia y no los cuenta como "waiting on you" (`status.ts`); 5 `--help` con flags, 13 scopes, efforts (`help.ts` + comandos); 6 rechazar flags desconocidos; `--json` soportado o error; 7 decidir `version:` vs `schema_version:` (`spec.md:10` + 7 templates + 7 schemas); 8 quitar "shipped in 0.3.0" del ROADMAP; 9 tabla de exit codes en README y `--help`; 10 partir README (80 líneas + `docs/guide/`) y CHANGELOG en Added/Changed/Fixed; 11 aplicar `gate.requires` o borrarlo; quitar `dashboard` del "refuses".
