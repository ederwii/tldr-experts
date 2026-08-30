# Auditoría — economía de tokens y legacy (2026-08-29, main 4c0e070, solo lectura)

**Medición real:** `tldrx next --prepare` sobre copia de `~/aparece-v2`, run `260830-decisions-gate`, stage `01-what/what`. Precios asumidos: Opus 5 $5/$25 por MTok, Sonnet 5 $2/$10, Haiku 4.5 $1/$5; cache write 1.25×, read 0.1×. Tokens ≈ bytes/3.6.

## A. Flujo de tokens — un stage (MEDIDO: prompt.md = 159.575 B ≈ 44.3k tok)
| Sección | Bytes | % | Regla |
|---|---|---|---|
| `stage.md` + placeholders | 3.769 | 2% | fijo |
| `## Inputs` (16 ficheros) | 72.283 | 45% | declarados enteros; seeds comparten 64 KB (`seedInputs.ts:25`), tope 20 inputs (`:91`) |
| 9 bloques de expert | 83.523 | 52% | `expert.md` + 64 KB de knowledge POR EXPERTO (`expertKnowledge.ts:42`) |

- Experts: 1 stage + 1 stack + 7 domain; 8 de 9 entraron solo por `repo aparece-v2`, no por path (`selectExperts.ts:178-179`).
- `{{facts}}`/`{{conventions}}` se calculan (`prompt.ts:152-177`) y se tiran: solo `watch/stage.md` usa placeholders.
- Handoffs previos: solo si `stage.yml inputs:` los nombra. Orden final (`prompt.ts:61-74`): stage → Inputs (volátil) → Previous attempt → experts (estable) — experts al FINAL.
- El sub-agente: `Read, Write, Edit, Glob, Grep` (`spawnAgent.ts:27`) + `Bash(<cmd>)`; el prompt dice "ONLY ones you may read" (`prompt.ts:109`) pero nada lo impone. Solo acotan `timeout_s` y `--max-budget-usd` (stop-after-turn; medido $5,15 vs $1,50, `spec.md:513-520, 717-725`). No hay contador de lecturas.
- Extrapolación legacy (3 repos, 800k LOC, 12 experts × 40 KB): 580 KB ≈ 165k tok/stage, 85% experts → Sonnet $0,41/stage, $16,50 por programa de 8 runs; Opus $41,26 — solo componer el prompt. Con el default de 64 KB/expert: 868 KB ≈ 247k tok, por encima del contexto de Haiku 4.5, el modelo del stage Watch (`stages/watch/stage.yml:18`) → fallo duro. aparece con los 9 experts al techo: ≈664 KB ≈ 184k tok, 4,2× lo de hoy.

## B. Peores casos
1. Knowledge sin cap global: presupuesto por experto (`expertBundle.ts:67,75-80`); orden "más reciente primero" (`expertKnowledge.ts:116-121`); cap solo de cuántos domain experts (8).
2. Asimetría medida: el budget de seed (64 KB) tiró `ADR-D013-DELIVERY-ZONE-GEOMETRY.md` (5.863 B) entero — decisión #6 del run — mientras 70.923 B de knowledge genérico pasaron intactos (`prompt.md:989`).
3. Mapa: NO es el problema. `graphify-out` 4,9 MB en disco, `.tldrx/map` 24 KB inlineado; O(1) en tamaño de repo (`StaticProvider.ts:18-19`, `graphJson.ts:34`); graphify sin LLM: 0 tokens.
4. Training light: grep ≤12 keywords (`selectFiles.ts:45`) sobre ≤4.000 ficheros, inline ≤40 ficheros / 96 KB (`Training.ts:58-62`), techo $2; pero el agente tiene `BASE_TOOLS` y puede leer el repo entero.
5. Seeds: 50 × 2 MB (`collectSeed.ts:28-29`) — 2 MB nunca es sensato; al prompt caben 64 KB. `seed triage` bien acotado (120 KB, 2 KB/doc, $1).
6. `run new --from` distill: determinista, 0 tokens.
7. What sobre monolito legacy: Sonnet 20 KB/turno → 60 turnos ≈ $6,35 (Opus ≈ $16); cierra solo por timeout o stop-after-turn.
8. Build: `MAX_TOUCHED_FILES=24`, 64 KB (`build/prompts.ts:27-28`); `touches` vacío ⇒ 0 inline pero developer conserva Read/Glob/Grep.
9. `run auto`: `MAX_ITERATIONS=96`; `--max-usd` entre stages, nunca dentro (`runAuto.ts:109-116`).
10. Reintentos: `MAX_ATTEMPTS=2`; el intento 2 recibe error + nota, no los artefactos del 1 (`runNext.ts:882-899`) — se paga y reescribe desde cero.
11. Prompt caching: cero (`grep cache_control` = 0); `usage` solo guarda input/output (`envelope.ts:44-45,78-79`); orden del prompt es el contrario al cacheable. La spec ya midió 105.698 tokens de cache-creation en un turno: write 1.25× y nunca read.

## C. Lo que ya protege
Budget gate antes del spawn con comando de arreglo (`runNext.ts:419-449`); `per_agent_max_usd` + share + `--max-usd` mínimo (`:1001-1005`); suelo $0,25; stop-after-turn documentado y medido (`spec.md:717-725`); mapa AST local 0 tokens; knowledge como caché; inputs inlineados con truncado declarado; `skip_if`; `--prepare/--commit`; worktrees; distill determinista; coste registrado aunque falle (`runNext.ts:371-379`).

## D. Diseño 10/10 para legacy (impacto/esfuerzo)
1. Reordenar el prompt: experts ANTES de inputs (`prompt.ts:61-74`) → 85% prefijo estable → cache read 0,1× vs write 1,25×: ~12× sobre la mayor partida. Instrumentar primero `cache_creation_input_tokens`/`cache_read_input_tokens` en `envelope.ts:75-80`.
2. Presupuesto global de prompt + context ledger en `assemblePrompt` (`runNext.ts:830-872`): bytes por sección en `--prepare`/`--dry-run`, negativa dura sobre N KB. Hoy a medias: `pending.json` lleva bytes por experto, sin total.
3. Knowledge por relevancia, no "comparte repo" (`selectExperts.ts:158-187`): `byRepo` opt-in, match por path (`citedPaths`, `story.touches`, k-hop); UN presupuesto repartido.
4. Cap de lecturas por stage (`--max-reads`, contando Read del stream) en `spawnAgent.ts:82-91`.
5. Un solo presupuesto compartido input+knowledge (resuelve B2).
6. Reuso de intento: outputs del intento rechazado como input del siguiente (`runNext.ts:855`).
7. `tldrx cost` + `run estimate` (datos ya en `agent.result`; falta agregador y tokens de caché).
8. Seam analysis para `migration`/`refactor` (`workflows/migration.yml:22-24` lo promete; nada lo implementa): k-hop desde `graph.json` (hoy solo 8 hubs en init, `GraphifyProvider.ts:84-106`).
9. Discovery por muestreo (centralidad + hotspots; `graphJson.ts`, `gitChurn.ts` ya lo calculan).

## E. Nota: 6/10 hoy → 9/10 con D1–D7
Lo fijan: (1) 52% del prompt es knowledge no pedido, 8/9 experts por repo; (2) tope solo por experto → 4,2× al entrenar, y a 12 experts supera el contexto de Haiku; (3) presupuesto no es cap y la exploración no está acotada. Mapa, distill y caps de training/build/seed están bien. El 10 no depende de tldrx: stop-after-turn es de la plataforma.
