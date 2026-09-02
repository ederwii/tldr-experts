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
