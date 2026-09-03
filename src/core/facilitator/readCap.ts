/**
 * `max_reads` — the only brake on exploration that acts BEFORE the money is spent.
 *
 * `--max-budget-usd` is stop-after-turn: measured 2026-08-29, a 597 s training
 * turn spent $5.15 against a $1.50 ceiling and was only then killed (spec §2.3,
 * §5). `--effort` changes what a turn costs but not how many turns there are. And
 * the sub-agent holds `Read`, `Glob` and `Grep` (`spawnAgent.ts`, `BASE_TOOLS`),
 * so a What stage over a legacy monolith can read the repository for as long as
 * the wall clock allows: the prompt says "these files are the ONLY ones you may
 * read", and nothing enforced it.
 *
 * Counting those three tools off the stream and stopping the process at a ceiling
 * does enforce it, and it is countable without a second model call — the events
 * are already arriving (`agentEvents.ts`). Reads are counted when they COMPLETE,
 * so the stop lands after the current tool rather than in the middle of it.
 *
 * `[assumption]` — the four numbers below are not measured. They are sized from
 * what each stage is FOR: What/How/Plan read documents and a bounded slice of
 * code; Build edits a story's files and re-reads them; Watch transcribes what an
 * upstream pass already decided and should barely read at all.
 */

/** The tools that count against the cap. Writes and commands do not. */
export const READ_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];

export const DEFAULT_MAX_READS = 120;
export const BUILD_MAX_READS = 200;
export const WATCH_MAX_READS = 60;

export function isReadTool(name: string): boolean {
  return READ_TOOLS.includes(name);
}

/** The shipped ceiling for a stage id, when `stage.yml` sets no `max_reads`. */
export function defaultMaxReads(stageId: string): number {
  if (stageId === "build") return BUILD_MAX_READS;
  if (stageId === "watch") return WATCH_MAX_READS;
  return DEFAULT_MAX_READS;
}

/** `reads 37/120` — one string, used by the UI footer and the stage report. */
export function readsLabel(reads: number, cap: number): string {
  return cap > 0 ? `reads ${String(reads)}/${String(cap)}` : `reads ${String(reads)}`;
}

/**
 * What `tasks[].stopped_by` records and the stage error says when the cap bit.
 * A stopped stage is a FAILED stage — it did not finish its work — but the reason
 * has to be distinguishable from a crash, because the fix is a number in a file.
 */
export const STOPPED_BY_MAX_READS = "max_reads";

export function readCapError(reads: number, cap: number, provider: "claude" | "codex" = "claude"): string {
  const unit = provider === "codex" ? "command executions" : "reads";
  const remedy = provider === "codex"
    ? "or reduce the commands the stage needs to execute."
    : "or give the stage the files it needs as declared inputs instead.";
  return `stopped after ${String(reads)} ${unit}: the stage's max_reads is ${String(cap)}. `
    + "Raise `max_reads` in the stage file or `--max-reads <n>` for one run, "
    + remedy;
}
