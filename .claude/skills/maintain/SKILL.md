---
name: maintain
description: Maintain this repo by working its GitHub issue backlog end to end — triage an issue, fix issue #N, review before merging, run a merge wave, and cut a release. Use when asked to maintain tldrx, work the backlog, take an issue, or ship a version.
---

# maintain — a maintainer's circuit for this repo

This is a **workflow**, not a rulebook. The rules live in `AGENTS.md` and `docs/RELEASING.md`
and are cited here by section, never restated: two copies drift, and drift between rule files
is the failure mode this repo exists to kill. Read `AGENTS.md` before the first tool call of a
cycle; when it and this file disagree, `AGENTS.md` wins and this file is the thing to fix.

The circuit below was run twelve times over two days. The numbers in it are measured on those
runs, not estimated.

## 0. Coexistence — before anything

Other sessions may be working this same repo.

- `ListAgents` first. If another session is live, exchange **file sets** by message before
  either of you starts: two cycles that touch disjoint files can run at once, two that touch
  `src/core/facilitator/executors/build.ts` cannot.
- **Never merge while another session's release is running** — and note there is NO detector
  for that. `scripts/release.sh` writes no marker (only a merge wave does, §2), so this is a
  question you ASK: `SendMessage` each live peer "is a release in flight?". One signal you can
  read yourself, and it is a hint rather than a check: a `release: X.Y.Z` commit on
  `origin/main` with no `vX.Y.Z` tag yet means one is mid-flight. A release moves `main`, tags
  it and pushes; a merge wave in the middle of that is how a half-released state happens.
- When a release lands mid-cycle, the released CHANGELOG section becomes immutable
  (`AGENTS.md` §5). Your unreleased bullets move under a NEW `## <next> — unreleased`
  heading; whether that next version is a patch or a minor is the judgement in
  `docs/RELEASING.md` "What to consider (judgement, not automated)" — patch for fixes only,
  minor when a command, file schema or hook changed behaviour.
- A wave already running in the shared checkout has a marker and a lock; §2 says what it is
  and what to do about it. Wait.

## 1. Intake and triage

For each candidate issue: `gh issue view N`.

**Reproduce the measurement on current `origin/main` BEFORE touching anything.** Issues go
stale in days here: one claimed Build was sequential when parallel execution had already
shipped, and the fix would have been for a bug that no longer existed. Read the cited
`file:line` at today's `main`, run the command the issue ran, and label what you got
`measured` / `inferred` / `assumed` (§1).

Then classify, out loud, one of four:

| verdict | what you do |
|---|---|
| **fix** | it reproduces and it is in scope — into §2's implement loop |
| **refute** | it does not reproduce — close with the measurement that refutes it (§11). A measured refutation is a valid close, not a failure. |
| **duplicate** | say which issue subsumes it and why, close |
| **owner decision** | the repo cannot answer it — ask, do not guess |

**Owner decisions** go to the owner's bridge, if one is installed. You detect one the same way
you detect anything else available to you: a skill in your visible skills list whose description
says it reaches the owner or asks the owner for a decision. If there is none, ask in the
terminal. What the bridge is asked for is always the same shape: one question answerable in
one tap, a safe default, and a timeout. Never present a system-default answer as the owner's
decision — if the timeout applied the default, say so in those words. If no bridge is
installed, stop and ask in the terminal; never work around a silent bridge by guessing.

**Batch size: at most 3 issues per cycle**, and prefer issues whose file sets do not overlap.
Overlapping file sets turn into rebases, and a rebase mid-cycle costs more than a second cycle.

## 2. Implement — one sub-agent per issue

One sub-agent per issue, on the strongest model, in **its own worktree from `origin/main`**
(`AGENTS.md` §2 — the shared checkout is touched only by `scripts/merge-wave.sh`). The brief
template is in `references/sub-agent-briefs.md`.

Non-negotiable inside the brief, each one from §1/§3/§8:

- **Red-first**, with the verbatim RED output kept for the close, plus the mutation check
  (break the fix, confirm the new test goes red — both halves if the fix has two).
- **Gates without pipes, each exit code on its own line**: typecheck, tests, build, docs build,
  and the runtime seam grep (§3). A pipe eats the exit code.
- Commit with the repo's trailers; **the sub-agent STOPS before merging.** Merging is §4's job
  and it happens after §3's review.
- New out-of-scope bugs are filed as issues with evidence, not fixed in the branch (§1).

**At most 2 implementers at once.** Machine load is not a style preference here: known-flaky
concurrency tests redden under it, and a red gate you caused by oversubscribing costs a full
re-run to disprove.

## 3. Fresh review BEFORE merge — mandatory

A **separate** sub-agent that did not write the code reviews the branch diff. A mid-tier model
is enough: measured across these twelve waves, mid-tier reviewers found the real defects, so
spending a stronger model here buys nothing yet.

The reviewer reads the branch diff against `AGENTS.md` §1, §7 and §8, and reports findings as
**concrete failure scenarios** — the input, the path taken, the wrong output — each labelled
`CONFIRMED` (it ran the scenario) or `PLAUSIBLE` (mechanism only). No style opinions.

The implementer is then resumed — `SendMessage` to its name from `ListAgents` — with either
the fix list or the single word `merge`.

**Why this step is not optional.** Over twelve waves, pre-merge review found a real Important
defect in **4 of them** — checkable from `git log`: `2a6413f` (fixing `cbd5c4b`), and the
pre-merge fixes that landed inside `28a987e`, `674049a` and `103ff96`. The one time review ran *after* the merge, the defect it found sat on
`main` for two hours before anyone could act on it.

## 4. Merge and verify

- `scripts/merge-wave.sh <branch> "<merge message>"` — **two arguments**, run from the shared
  checkout only (§2). It takes a lock; a second invocation waits rather than racing. If it
  refuses, read WHY before doing anything else.
- Long waits (the lock, a CI watch, a running suite) happen in bounded foreground loops inside
  your turn. Ending the turn to "wait" strands the work — nothing wakes you.
- CI per `AGENTS.md` §4, all of it: an UNFILTERED run list matched on `headSha` yourself
  (the filtered form returns `[]` for minutes while the runs exist), both workflows, and the
  assertion that jobs > 0 and steps > 0. **"No checks found" is a failure state, not a pass.**
- Close the issue in house style (§11): merged sha, test delta with both ends measured, CI run
  ids with the §4 assertion, RED verbatim, and the design paragraph for any judgement call.
- Clean up the worktree and delete the branch (§2).

## 5. Release cadence

Only when the owner has approved releasing (§1's ask shape). The full checklist is
`docs/RELEASING.md`; the shape is `AGENTS.md` §6.

1. Prep on disk: the CHANGELOG has `## <V> — unreleased` and README's release table has the
   matching `unreleased` row as its TOP row.
2. `scripts/release.sh <V> --tag beta`, run as a command whose LAST line echoes the release
   exit code. Nothing is pushed if the gate goes red; the script prints the exact undo.
3. Do not reach for the manual tag/publish commands: CLAUDE.md, "Claude-specific notes", says
   what happens and why.
4. Watch publish, ci and docs under §4's rules; then verify the published dist-tags, cut the
   GitHub release from the CHANGELOG section, and refresh the global install.

## 6. Reporting

**Milestones only**, to the owner's bridge if one is installed: a merge landed, a release
published, an owner decision is needed. Human wording — what changed and what it means, not
file paths or symbol names.

Keep the orchestrating session's context compact: read sub-agent **reports**, never their
transcripts, and ask for ten-line reports.

## 7. House traps that have cost time here

- **No private workspace names anywhere in tracked files** (#191). Real workspaces are local
  evidence; what ships is synthetic.
- **A golden byte change IS a behaviour change** (§12). Either it is the change you meant and
  the commit says so, or you revert. Never "update the golden" to make a diff go away.
- **`docs:build` is a gate** (§3), not a nicety — a moved page or a throwing generator used to
  reach `main` green and die at deploy.
- Respect the mandate/line budgets a file declares; a prompt that overflows its budget is a
  behaviour change.
- When the host session commits a review by hand (`tldrx next --commit --review`), run
  `tldrx next --commit --review --check` first.
- zsh here: `${PIPESTATUS[0]}` is a bashism, and `status` is a reserved variable name.

## 8. Usage — para el dueño del repo

Se invoca con `/maintain`:

- **`/maintain`** — sin argumentos: triaje del backlog abierto y una propuesta de ciclo de
  hasta 3 issues, con el motivo de cada una. No toca nada hasta que apruebes la lista.
- **`/maintain #182 #187`** — trabaja esas issues: reproduce, implementa, revisa antes de
  mergear, mergea y las cierra.
- **`/maintain release 0.12.0`** — corta esa versión, solo cuando ya aprobaste publicarla.

**Qué te va a preguntar, y cuándo**: solo lo que el repo no puede responder — una decisión de
diseño ambigua, algo irreversible, o el permiso para publicar una release. Cada pregunta llega
por el puente del dueño (si hay uno instalado) con opciones y un default seguro; si no hay
puente, se detiene y pregunta en la terminal. No pregunta nada que pueda medir.

**Cómo detenerlo**: respondé "parar" a cualquier pregunta, o interrumpí la sesión. Un ciclo
detenido no deja nada a medias en `main`: los sub-agentes tienen la instrucción de parar antes
de mergear (todavía no es un bloqueo técnico — ver #192), y un merge wave interrumpido se
deshace solo.
