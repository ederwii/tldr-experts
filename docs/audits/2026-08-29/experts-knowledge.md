# Auditoría — expertos y conocimiento (2026-08-29, main 4c0e070, solo lectura)

**Score: 6/10.** El diseño es más honesto que la mayoría (la escalera ya se auto-corrigió: el ledger dice `level_after:5`, el archivo dice `level: 3`) y ~60% de los hallazgos muestreados son genuinamente caros de re-derivar. Pero nada mide el valor de un hallazgo: el prompt de training premia *archivos distintos*, no *insight*; ~1/3 de cada archivo es un índice redundante; y la inyección mete 9 expertos y ~68 KB de C# en la etapa What sin ranking ni tope global, diciéndole al modelo "no abras los archivos, la cita ya es prueba".

## A. ¿El conocimiento sirve? — 9 valioso / 6 barato / 0 falso (+1 peligroso)
Muestra de 15 bullets en los dos expertos entrenados (sesgada hacia `## Gotchas`).

Valioso (9): `PeriodicJobRunner.cs:32` `options.Get(job.Name)` vs `AddOptions<BackgroundJobOptions>(jobName)` (`BackgroundWorkServiceCollectionExtensions.cs:45`) → job con defaults en silencio si difieren (verificado); `TryAddSingleton<TJob>` + `AddHostedService` incondicional (`:43-44`); `if (status < worst)` en `JobHeartbeatHealthCheck.cs:31` es worst-wins; `HostRunner.cs:59` `.All(inner is OptionsValidationException)`; `KeyGrammar.Pattern` nunca valida y contradice su docstring (`KeyGrammar.cs:10`); `DenyAllAccessResolver` + `RequirePermission` sin call-site; `grep -rn UseHttpsRedirection src/` → 0 hits (ABSENT confirmado).

Barato (6): paráfrasis verbatim de docstrings en `AuthenticationOptions.cs:39-41`, `CurrentIdentityResponse.cs:6-7`, `AuthorizationServiceCollectionExtensions.cs:26`, `HealthCheckOptionsFactory.cs:8`, header de `Program.cs`, `ParseInformationalVersion`. `trainingPrompt.ts:198` prohíbe *citar* un docstring; no prohíbe *parafrasearlo*.

Peligroso (1, de clase): la cabecera de `aparece-api.md` afirma *measured* `dotnet build` exit 0 citando `[src: aparece-v2:.tldrx/workspace.yml:19]` — esa línea es `build: dotnet build`, la declaración del comando, no un resultado. Igual "78/78 passed, exit 0" citando `scripts/test.sh:105`. La cita resuelve y no sostiene la afirmación; el validador solo chequea que la línea exista (`knowledgeFile.ts:125`).

Ponderado por sección: `## Sources` = 41/107 bullets en platform (38%) y 18/56 en abstractions (32%), cada uno repite una cita ya hecha. Estimación a nivel archivo: ~40-45% valioso. 5 citas a código verificadas: 5/5 resuelven y sostienen.

## B. La escalera es gameable, y el prompt enseña cómo
`competencyLevel.ts:105-109`. Medido: `training.jsonl` de `aparece-platform` registra `level_before:0, level_after:5` por $1.21; hoy `competencies.yml` dice `level: 3` (run-cap añadido después). Receta Goodhart para 5/5: leer 20 archivos cualesquiera, un bullet trivial por archivo, un `$ dotnet build → exit 0`. El prompt lo dicta: *"Citing the same file twelve times is worth one row; reading twelve files is worth twelve"* (`trainingPrompt.ts:82-83`). Recompensa amplitud, no profundidad. Cap de 180 d es acantilado, no decaimiento.

## C. Selección e inyección: llega casi todo, sin ranking
`selectExperts.ts:158-187`. En aparece-v2 los 7 expertos de dominio declaran `repos: [aparece-v2]`, cap 8, y `runNext.ts:850` pasa `citedPaths: inputs` (facts.yml, map) que no intersectan código → What carga 9 expertos incl. `deploy` y `artifacts`, alfabético. No hay tope global (`expertBundle.ts:67`, `used` local). ~69.5 KB de C# de bajo nivel entran completos en una etapa de elicitación con `budget_usd: 4`. Instrucciones enfrentadas: `expertKnowledge.ts:241-243` "Do not open the files they point at: the citation is already proof" vs `stages/how/stage.md:72` "`.tldrx/experts/*` is not evidence". Vector de lavado de una afirmación falsa hacia `design.md`.

## D. Role experts: diseño correcto; loop a medias
`roleTraining.ts:46-65` rechaza light; `mineRuns.ts:33` mina `handoff.md` y `retro.md`. Falta: los 5 role experts en `level: 0`; `retro.md` solo si un humano corre `tldrx retro`; veredictos del reviewer y DoD fallidos (`src/core/build/{review,outcome}.ts`) nunca llegan a un experto. Feedback loop gates→conocimiento: ausente. Fix: Build escribe `retro.md` determinista (changes del reviewer, `dod` ≠0 al primer intento, gates rechazados + motivo).

## E. Economía: $1.25 por training, no medible hoy
`training.jsonl`: platform $1.21 / 15k output tokens; abstractions $1.29. `aparece-api` sin ledger (ruta `--print-prompt`). Experimento más barato (~$12, cero código): misma etapa How dos veces sobre el mismo run con `expert_knowledge_bytes` 0 vs 65536; comparar rutas citadas que existen, `[src:]` que resuelven, coste.

## F. Gaps y arreglos, por impacto
1. La cita resuelve pero no sostiene → `knowledgeFile.ts` + `srcToken.ts`: una afirmación de ejecución ("exit 0", "N/N passed") exige `src` `$ cmd → exit n`.
2. Criterio de valor en el training prompt → `trainingPrompt.ts:57-61`: un hallazgo es lo que un modelo no re-deriva leyendo el archivo una vez; sustituir `:82-83` por premio a cruces entre archivos.
3. Tope global de conocimiento + ranking real → `expertBundle.ts:65-95`: `total_knowledge_bytes` por etapa, ordenar por intersección de rutas citadas antes de truncar.
4. Scoping: 29% / 55% / 22% de citas fuera del `## Domain` declarado; 16 archivos citados por dos expertos → `selectFiles.ts` inlinea solo el dominio; `knowledgeFile.ts` avisa.
5. Loop retro→conocimiento → `executors/build.ts` escribe `retro.md` determinista.
6. `## Sources` redundante (38%) → `knowledgeFile.ts:21`: quitar o excluir del conteo/inyección.
7. Confianza por hallazgo estructurada + decaimiento continuo (`competencyLevel.ts:106`).
8. Contradicciones entre expertos: sale gratis del punto 4.

Lo que sostiene el 6: la escalera atrapó su propio fallo con prueba en disco; 5/5 citas a código verificadas. Lo que lo baja: optimiza cobertura de archivos, no valor, mientras dice al consumidor que no verifique.
