/**
 * How long a stage took, from `run.yml`'s two timestamps — and, when it did not
 * take a knowable length of time, WHICH end is missing.
 *
 * One implementation, two surfaces (#120). This arrived in `dashboard/render.ts`
 * with #118 and the dashboard's phase timeline was its only caller; `tldrx run
 * status` reads the same `run.yml` and printed neither number nor absence, so the
 * page and the CLI disagreed about what is knowable from one file. Rather than a
 * second subtraction — the thing this repo's guards exist to catch — the pair
 * moved here, to a leaf that imports nothing and that both callers can reach
 * without dragging a renderer into a terminal command.
 *
 * **The `dash` prefix is load-bearing and cannot be renamed.** These two reach the
 * browser through `Function.prototype.toString()` (`clientRenderer()` in
 * `render.ts`), which serialises the definition NAME along with the body — so the
 * page's own call sites spell `dashDuration(...)`, and a rename here is a
 * `ReferenceError` on the live page rather than a build error. That is also why
 * both stay **closure-free**: no module constant, no import, nothing but their
 * arguments, their locals and the globals every browser has.
 */

/**
 * `"2h 38m"` from a stage's two timestamps — or `""` when they do not yield one.
 *
 * DERIVED HERE, and deliberately not stored on the model (#118). A duration is a
 * subtraction, it exists only when both ends do, and a stored field would have to
 * pick a number for the case where one end is missing. `""` is that case, and
 * `dashDurationAbsence` says which end it was; the caller never prints a `0`
 * standing in for "nobody wrote it down".
 *
 * Pure, like `dashAgo` and for the same reason: the same model renders the same
 * page. Neither `Date.now()` nor a timezone enters into it — this is the gap
 * between two instants, and a gap has no locale.
 */
export function dashDuration(startedAt: string | null, endedAt: string | null): string {
  if (startedAt === null || startedAt === "" || endedAt === null || endedAt === "") return "";
  const from = new Date(startedAt).getTime();
  const to = new Date(endedAt).getTime();
  if (isNaN(from) || isNaN(to) || to < from) return "";
  const total = Math.round((to - from) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  if (minutes > 0) return `${String(minutes)}m`;
  return `${String(total)}s`;
}

/**
 * Why there is no duration — named, never left blank.
 *
 * "The stage has not ended yet" and "nobody recorded either end" are different
 * facts about a run, and a reader deciding whether a stage is stuck needs to
 * know which one they are looking at. An empty cell tells them neither and reads
 * as "it took no time".
 */
export function dashDurationAbsence(startedAt: string | null, endedAt: string | null): string {
  const noStart = startedAt === null || startedAt === "";
  const noEnd = endedAt === null || endedAt === "";
  if (noStart && noEnd) return "not recorded — run.yml carries neither started_at nor ended_at";
  if (noStart) return "not recorded — run.yml carries no started_at for this stage";
  if (noEnd) return "not recorded — this stage has a started_at and no ended_at yet";
  return "not recorded — run.yml's two timestamps do not yield one "
    + "(unparseable, or ended_at before started_at)";
}

/**
 * `"30m"`, `"90s"`, `"2h"`, `"45"` → milliseconds. `null` when it is not a duration.
 *
 * Added 2026-09-07 with `run auto --notify-every` and `--wait-answers` (gh #180), which
 * are the first two flags in the CLI that take a SPAN rather than an instant or a count.
 * One implementation, here, next to the other two things this file knows about durations —
 * a second parser is exactly the drift AGENTS.md §7 refuses, and two flags on one command
 * disagreeing about whether `5` means seconds or minutes would be an unusually cruel bug.
 *
 * A bare number is SECONDS: it is what `timeout_s` and every `_s` field in the schemas
 * mean, so a reader who has seen one of those is not surprised. Zero and negatives are
 * `null` rather than 0 — "notify me every no time" is not a request, it is a typo, and the
 * caller refuses it by name.
 *
 * Not closure-free and not `dash`-prefixed: unlike the two above, this one never crosses
 * into the browser.
 */
export function parseDurationMs(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (match === null) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2] ?? "s";
  const scale = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(value * scale);
}

/**
 * Where a task row's `duration_ms` came from — and therefore what it MEASURES.
 *
 * Two spans, and they are not the same quantity (#184). `spawned` is the wall
 * clock around `runtime.spawn` in `spawnAgent.ts`: the sub-agent's own process,
 * start to exit, with nothing of ours inside it. `prepare-to-commit` is the gap
 * between the `--prepare` bundle's `prepared_at` and the instant `--commit`
 * recorded the row — which is the only span the framework can see for an
 * in-session turn, and it INCLUDES whatever the host did between the two
 * commands (reading the prompt, thinking, running the sub-agent, typing).
 *
 * They are kept apart, and the basis is written beside every number, because
 * averaging them would produce a figure that is neither. Nothing here may be
 * called "the sub-agent's time" except the `spawned` one.
 */
export const DURATION_BASES = ["spawned", "prepare-to-commit"] as const;
export type DurationBasis = (typeof DURATION_BASES)[number];

/**
 * `"4m 12s"`, `"12s"`, `"1h 3m"` — a measured millisecond span, for a person.
 *
 * The SECOND duration formatter this file holds, and deliberately so rather than
 * a second file: `dashDuration` takes two timestamps and subtracts them, this
 * takes a span that was already measured. They share the hours/minutes/seconds
 * shape on purpose — a run's stage rows and its task rows must not read in two
 * different notations — and keeping them adjacent is what makes a drift between
 * them visible in one screenful.
 *
 * Sub-second spans round DOWN to `0s` rather than up: a turn that took 400 ms is
 * a turn that took under a second, and `1s` would be a number nobody measured.
 * Negative or non-finite input yields `""` — the caller prints its absence
 * sentence instead, never a zero standing in for "nobody wrote it down".
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  if (minutes > 0) return `${String(minutes)}m ${String(seconds)}s`;
  return `${String(seconds)}s`;
}

/**
 * The cell `tldrx cost` prints for one attempt: `"4m 12s (spawned)"`, or the
 * absence sentence when the row carries no span.
 *
 * "not recorded" and never `0s`, for the same reason `dashDurationAbsence`
 * exists: every task row written before #184 has no `duration_ms` at all, and a
 * zero there would say the turn was instantaneous rather than that nobody timed
 * it. The basis rides in the same string as the number so the two cannot be
 * separated by a column layout — a bare `4m 12s` beside an in-session row would
 * read as the sub-agent's time, which is the one thing it is not.
 */
export function durationCell(ms: number | undefined, basis: string | undefined): string {
  if (ms === undefined) return "not recorded";
  const text = formatDurationMs(ms);
  if (text === "") return "not recorded";
  return basis === undefined ? text : `${text} (${basis})`;
}

/**
 * The same for a SUM over several attempts, with the honesty the sum needs.
 *
 * A stage whose attempts carry two different bases has no single quantity to
 * total, and one whose attempts carry none has nothing to total at all. Both are
 * said in words rather than resolved into a number: `"12m 4s (spawned)"`,
 * `"12m 4s (mixed bases: spawned + prepare-to-commit)"`, `"not recorded"`, and
 * `"6m 0s (spawned) — 2 of 5 attempts not recorded"` when only some rows have one.
 */
export function durationSum(
  rows: readonly { readonly ms?: number; readonly basis?: string }[],
): string {
  const timed = rows.filter((row) => typeof row.ms === "number" && Number.isFinite(row.ms) && row.ms >= 0);
  if (timed.length === 0) return "not recorded";
  const total = timed.reduce((sum, row) => sum + (row.ms ?? 0), 0);
  const bases = [...new Set(timed.map((row) => row.basis ?? "unrecorded basis"))].sort();
  const label = bases.length === 1 ? bases[0] ?? "" : `mixed bases: ${bases.join(" + ")}`;
  const missing = rows.length - timed.length;
  return `${formatDurationMs(total)} (${label})`
    + (missing === 0
      ? ""
      : ` — ${String(missing)} of ${String(rows.length)} attempts not recorded`);
}
