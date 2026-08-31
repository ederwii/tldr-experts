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
import { resolveDependencies, slugOfRun, type DependencyInput } from "../run/dependencies.ts";
import { whatIsWaiting, type Waiting } from "../run/runStatus.ts";
import { questionsCard } from "../run/decisionCards.ts";
import { renderDecisionCard } from "../ui/decisionCard.ts";
import { isMovable } from "../run/waiting.ts";
import type { RunFile } from "../run/RunFile.ts";
import type { PendingItem } from "./PendingItem.ts";

/** The marker on the first run a human could actually move. */
export const NEXT_MARK = "← next";

export { slugOfRun };

/**
 * Every run on disk that parses, as the dependency resolver wants it.
 *
 * ALL of them, not only the open ones: a dependency satisfied by a finished run
 * has to read as satisfied. `listRunDirs` is newest-first, which is the order
 * `resolveDependencies` uses to break a slug collision.
 */
function dependencyInputs(root: string): readonly DependencyInput[] {
  const out: DependencyInput[] = [];
  for (const dir of listRunDirs(root)) {
    let store: RunStore;
    try {
      store = RunStore.open(dir);
    } catch {
      continue;
    }
    const run = store.run;
    out.push({
      id: run.run === "" ? basename(dir) : run.run,
      status: run.status,
      dependsOn: run.triage?.depends_on ?? [],
      movable: isMovable(whatIsWaiting(run, store.runDir).kind),
      updatedAt: run.updated_at,
    });
  }
  return out;
}

export function runItems(root: string): readonly PendingItem[] {
  const open = RunStore.findOpen(root);
  const unreadable = unreadableItem(root);
  if (open.length === 0) return unreadable === null ? [] : [unreadable];
  const inputs = dependencyInputs(root);
  const known = new Set(inputs.map((input) => input.id));
  const statuses = new Map(inputs.map((input) => [input.id, input.status]));
  const resolved = new Map(resolveDependencies(inputs).runs.map((run) => [run.id, run]));
  const several = open.length > 1;
  let markedNext = false;

  const items: PendingItem[] = open.map((store) => {
    const run = store.run;
    const waiting = whatIsWaiting(run, store.runDir);
    // `blockedBy` carries run ids; the reader was proposed SLUGS, so say slugs.
    const blockedIds = resolved.get(run.run)?.blockedBy ?? [];
    const blocked = blockedIds.map(slugOfRun);
    const runnable = resolved.get(run.run)?.runnable ?? isMovable(waiting.kind);
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
    for (const id of blockedIds) {
      const status = known.has(id) ? statuses.get(id) : undefined;
      details.push(
        `blocked by ${slugOfRun(id)} — ${status === undefined ? "no run exists for it" : `it is ${status}`}`,
      );
    }
    if (waiting.kind === "gate") {
      details.push(`disagree instead: \`tldrx reject --run ${run.run} --note "<why>"\``);
    }
    // A run stopped on questions gets the DECISION CARD (design §F.3), not a list
    // of ids. Measured 2026-08-30: a host that showed an owner the question, the
    // options and a recommendation got both answers back in seconds; `Q1, Q2` is
    // a prompt to go and open a file. The ids are still there — they are the card's
    // own headings — so nothing a reader had before is lost.
    if (waiting.kind === "answer") {
      const card = questionsCard({
        runDir: store.runDir,
        runId: run.run,
        phaseId: run.cursor.phase,
        stageId: run.cursor.stage,
      });
      if (card === null) details.push(`open questions: ${waiting.questions.join(", ")}`);
      else details.push(...renderDecisionCard(card));
    }
    if (waiting.kind === "failed") details.push(waiting.message);
    details.push(...machineSignedDetails(run));
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

/** The actor an auto-signed gate records (`run/autoGate.ts` AUTO_GATE_ACTOR). */
const AUTO = "auto";

/**
 * Which gates the machine signed, and which stages a revocation left behind.
 *
 * `by: auto` used to live only in run.yml, the event log and `run status` — three
 * places nobody glances at (2026-08-29 audit, §B). A stage the facilitator
 * approved is exactly the one worth a second look, so this report names them and
 * hands over the command that takes one back.
 */
function machineSignedDetails(run: RunFile): readonly string[] {
  const stages = run.phases.flatMap((phase) => phase.stages.map((stage) => ({ phase, stage })));
  const auto = stages.filter((e) => e.stage.gate.status === "approved" && e.stage.gate.by === AUTO);
  const stale = stages.filter((e) => e.stage.stale === true);
  const details: string[] = [];
  if (auto.length > 0) {
    const named = auto.map((e) => `${e.phase.id}/${e.stage.id}`).join(", ");
    const first = auto[0];
    details.push(
      `${auto.length} gate(s) signed \`by: auto\`, not by a person — ${named}. `
      + `Take one back with \`tldrx reject --run ${run.run} `
      + `--stage ${first?.phase.id ?? ""}/${first?.stage.id ?? ""} --note "<why>"\``,
    );
  }
  if (stale.length > 0) {
    details.push(
      `${stale.length} stage(s) marked stale by a revoked approval — `
      + `${stale.map((e) => `${e.phase.id}/${e.stage.id}`).join(", ")}. Their files are still on disk `
      + "and were derived from a decision that has since been withdrawn.",
    );
  }
  return details;
}

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
