/**
 * Item 3: the runs that are already open.
 *
 * `RunStore.findOpen` and `whatIsWaiting` already answer "which runs are live" and
 * "what is each one waiting on" — this adds the two things a workspace-level
 * report needs and a single run cannot know:
 *
 *   the command   `next` / `answer` / `approve` / `reject`, chosen from the
 *                 waiting kind rather than left for the reader to work out;
 *   the order     a run created by `tldrx seed apply` records `triage.depends_on`
 *                 (spec §2.2), and a run whose dependency has not finished is not
 *                 the one to work on, however loudly it says `ready`.
 *
 * Dependencies are recorded as SLUGS, because they are the slugs the split
 * proposed; a run id is `<yymmdd>-<slug>`, so the slug is matched back to the
 * newest run carrying it. A dependency with no run at all counts as unfinished —
 * it was proposed to come first and it does not exist.
 */
import { basename } from "node:path";
import { listRunDirs } from "../../hooks/lib/workspace.ts";
import { PROJECT_WORK_DIR } from "../paths.ts";
import { RunStore } from "../run/RunStore.ts";
import { whatIsWaiting, type Waiting } from "../run/runStatus.ts";
import type { RunFile } from "../run/RunFile.ts";
import type { PendingItem } from "./PendingItem.ts";

/** The marker on the first run a human could actually move. */
export const NEXT_MARK = "← next";

/** `260829-decisions-gate` → `decisions-gate`; anything else keeps its whole id. */
export function slugOfRun(runId: string): string {
  return /^\d{6}-(.+)$/.exec(runId)?.[1] ?? runId;
}

/** Every run on disk that parses: slug -> its status, newest run per slug. */
function statusBySlug(root: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const dir of listRunDirs(root)) {
    let run: RunFile;
    try {
      run = RunStore.open(dir).run;
    } catch {
      continue;
    }
    const slug = slugOfRun(run.run === "" ? basename(dir) : run.run);
    if (!out.has(slug)) out.set(slug, run.status);
  }
  return out;
}

export function runItems(root: string): readonly PendingItem[] {
  const open = RunStore.findOpen(root);
  const unreadable = unreadableItem(root);
  if (open.length === 0) return unreadable === null ? [] : [unreadable];
  const statuses = statusBySlug(root);
  const several = open.length > 1;
  let markedNext = false;

  const items: PendingItem[] = open.map((store) => {
    const run = store.run;
    const waiting = whatIsWaiting(run, store.runDir);
    const blocked = (run.triage?.depends_on ?? []).filter((slug) => statuses.get(slug) !== "done");
    const runnable = blocked.length === 0 && MOVABLE.includes(waiting.kind);
    const isNext = runnable && !markedNext;
    if (isNext) markedNext = true;

    const details: string[] = [];
    if (isNext) {
      details.push(
        `${NEXT_MARK} — the first run you can move; \`tldrx run auto ${run.run}\` runs it headless `
        + "until something genuinely needs a person",
      );
    }
    details.push(`at ${run.cursor.phase} / ${run.cursor.stage} · run status ${run.status} · waiting: ${waiting.kind}`);
    for (const slug of blocked) {
      const status = statuses.get(slug);
      details.push(`blocked by ${slug} — ${status === undefined ? "no run exists for it" : `it is ${status}`}`);
    }
    if (waiting.kind === "gate") {
      details.push(`disagree instead: \`tldrx reject --run ${run.run} --note "<why>"\``);
    }
    if (waiting.kind === "answer" && waiting.questions.length > 1) {
      details.push(`open questions: ${waiting.questions.join(", ")}`);
    }
    if (waiting.kind === "failed") details.push(waiting.message);
    if (several) details.push("several runs are open, so every command here names its run id");

    return {
      kind: "run" as const,
      summary: summaryOf(run, waiting, blocked),
      command: blocked.length > 0 ? "" : commandFor(run, waiting),
      details,
    };
  });
  return unreadable === null ? items : [...items, unreadable];
}

/**
 * Run folders `RunStore` refused to open — one item, never silence.
 *
 * `findOpen` skips a run whose `run.yml` does not validate, which is right for
 * every command that acts on one: it cannot be acted on, and it must not hide the
 * ones that can. It is wrong for a report whose whole promise is "this is
 * everything that is waiting", because the alternative is printing
 * `nothing pending` at a workspace that visibly holds a run.
 */
function unreadableItem(root: string): PendingItem | null {
  const broken: string[] = [];
  for (const dir of listRunDirs(root)) {
    try {
      RunStore.open(dir);
    } catch (error) {
      broken.push(`${basename(dir)} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (broken.length === 0) return null;
  const first = broken[0]?.split(" — ")[0] ?? "";
  return {
    kind: "run",
    summary: `${String(broken.length)} run folder(s) in ${PROJECT_WORK_DIR}/ could not be read, `
      + "so nothing here can say what they are waiting on",
    command: `tldrx run status ${first}`,
    details: broken,
  };
}

/** Waiting kinds a human can act on right now. `done` and `blocked` are not. */
const MOVABLE: readonly Waiting["kind"][] = ["gate", "answer", "ready", "failed"];

function summaryOf(run: RunFile, waiting: Waiting, blocked: readonly string[]): string {
  const what = run.title === "" ? run.run : `${run.run} ("${run.title}")`;
  if (blocked.length > 0) {
    return `run ${what} cannot start yet — it was proposed to follow ${blocked.join(", ")}`;
  }
  switch (waiting.kind) {
    case "gate":
      return `run ${what} finished a stage and is waiting for you to approve it`;
    case "answer":
      return `run ${what} asked you ${String(waiting.questions.length)} question(s) and stopped for the answer`;
    case "failed":
      return `run ${what} failed at ${run.cursor.phase}/${run.cursor.stage} and is waiting to be retried or dropped`;
    case "ready":
      return `run ${what} is ready to run its next stage`;
    case "done":
      return `run ${what} has no stage left to run but is still open`;
    default:
      return `run ${what} is blocked at ${run.cursor.phase}/${run.cursor.stage}`;
  }
}

function commandFor(run: RunFile, waiting: Waiting): string {
  switch (waiting.kind) {
    case "gate":
      return `tldrx approve --run ${run.run}`;
    case "answer":
      return `tldrx answer ${waiting.questions[0] ?? "Q1"} "<your answer>" --run ${run.run}`;
    case "ready":
    case "failed":
      return `tldrx next ${run.run}`;
    default:
      return "";
  }
}
