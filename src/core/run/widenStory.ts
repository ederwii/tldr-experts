/**
 * `tldrx story widen <id> <path>… --note <text>` — one story's declared surface,
 * grown by a person, on the record (#171).
 *
 * The verb the framework had been pointing at and had never written. When Build
 * lands work in a file nobody scoped, auto-gate condition 7 refuses and the
 * decision card told the operator to *"add the path to a story's `touches:`"* —
 * while `cli/commands/story.ts` says, correctly, that `run.yml` and the story
 * files are the state (spec §1) and hand-editing them is forbidden by design. The
 * only sanctioned remedy for the commonest boundary refusal was an edit this
 * CLI's own rules forbid, and no TypeScript function wrote a `touches:` line:
 * `StoryPatch` had exactly two keys and `tldrx story` exactly one subcommand.
 *
 * **No format change.** `touches` is already required, non-empty and capped at
 * `MAX_TOUCHES` (`schemas/story.ts`), so appending changes a VALUE; `STORY_KEYS`
 * is untouched and the plan-contract pins stay green. What is additive is the
 * RECORD of the widening — a `story.touches_widened` event carrying the paths,
 * the note and the list before and after — because a surface that grew with
 * nothing in the log is a plan that claims to have declared something it did not.
 *
 * **The gate needs nothing.** `deriveSurface` (`run/boundary.ts`) reads story
 * `touches:` off disk at evaluation time, so a widened story makes condition 7
 * pass on the NEXT evaluation with zero boundary code touched. This verb runs no
 * agent, spends nothing, consumes no attempt, moves no cursor and changes no
 * status: it is the declaration, and nothing else.
 *
 * Signed with a `--note`, like `reopen`, and for the same reason: the note is the
 * whole of what a later reader gets about why the scope grew.
 *
 * **The `done` refusal is load-bearing at exactly the moment this verb is
 * reached, and that is deliberate.** Measured on the boundary fixture: when a
 * Build stage's auto gate refuses on condition 7, its stories are already
 * SETTLED — the story that wrote the offending path comes out of that run
 * `status: done` with `evidence:` naming its dod run, its commit and its review.
 * So the commonest way to arrive here is with a done story, and the answer is not
 * to let the declaration be back-dated over evidence that was written against a
 * narrower surface. It is `tldrx story reopen <id> --for-fix`, which the refusal
 * names: the fix round records that the story was reopened for a defect, this
 * verb records that its surface grew, and both are in the log in the order they
 * happened. `test/story-widen.test.ts` walks that path end to end.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_WORK_DIR } from "../paths.ts";
import { parseYaml } from "../yaml.ts";
import { splitFrontMatter } from "../schemas/frontMatter.ts";
import { MAX_TOUCHES } from "../schemas/planCommon.ts";
import { RunStore } from "./RunStore.ts";
import { ambiguousRunLines } from "./openRuns.ts";
import { normalisePath } from "./boundary.ts";
import { BUILD_PHASE, buildProgress, PLAN_DIR } from "./buildProgress.ts";
import { IMPLICIT_PLAN_FILE, updateImplicitPlan } from "../build/implicitPlan.ts";
import { StoryWriteError, updateStoryFront } from "../build/storyFile.ts";
import { validateEvent, type TldrxEvent } from "../events/Event.ts";

export interface WidenOptions {
  readonly root: string;
  /** The story id as typed, e.g. `S3`. */
  readonly storyId: string;
  /** The paths to add, repo-relative, as the operator typed them. */
  readonly paths: readonly string[];
  /** Required. A surface that grew for no stated reason is not a declaration. */
  readonly note: string;
  readonly runId?: string;
  readonly actor: string;
  readonly at: string;
}

export interface WidenOutcome {
  readonly code: number;
  readonly lines: readonly string[];
}

const EXIT_OK = 0;
/** Spec §3: `refused`. Every one of this verb's own refusals is a refusal to act. */
const EXIT_REFUSED = 2;
const EXIT_NOT_FOUND = 3;

/**
 * The states a story may be widened FROM.
 *
 * `done` is absent and that is the point: a done story has evidence written
 * against the surface it DECLARED, and widening it afterwards would make the
 * record say the plan declared something it did not — an audit record lying in
 * the dangerous direction (AGENTS §7). The way through is #58's
 * `tldrx story reopen <id> --for-fix`, and the refusal names it.
 */
const WIDENABLE: ReadonlySet<string> = new Set(["todo", "in_progress", "review", "blocked"]);

export function widenStory(options: WidenOptions): WidenOutcome {
  const id = options.storyId.trim();
  if (id === "") {
    return refuse(['story widen needs a story id: `tldrx story widen S3 platform/Auth.cs --note "why"`']);
  }
  if (options.note.trim() === "") {
    return refuse([
      `story widen needs --note: \`tldrx story widen ${id} <path> --note "why the scope grew"\``,
      "  the note IS the declaration — it is the whole of what the next reader gets about why this",
      "  story's surface is wider than the one the plan was approved over",
    ]);
  }
  // Normalised through the SAME function the boundary gate compares with
  // (`boundary.ts:139`), so a widening cannot land in a shape the gate will not
  // match: `./src/in.ts` declared against `src/in.ts` measured is a widening that
  // widens nothing, and it would refuse again at the very next evaluation.
  const asked = options.paths.map(normalisePath).filter((path) => path !== "");
  if (asked.length === 0) {
    return refuse([
      `story widen needs at least one path: \`tldrx story widen ${id} <path>… --note "…"\``,
      "  the paths are what the widening IS — there is nothing else in it",
    ]);
  }
  const traversing = asked.filter((path) => path.split("/").includes(".."));
  if (traversing.length > 0) {
    return refuse([
      `\`..\` is not allowed in a touched path: ${traversing.join(", ")}`,
      "  spec §2.13 refuses one, so writing it would leave a story file this framework's own",
      "  check rejects — the path is refused here instead, and nothing was written",
    ]);
  }

  const resolution = RunStore.resolve(options.root, options.runId);
  if (resolution.kind === "ambiguous") {
    return { code: EXIT_REFUSED, lines: [...ambiguousRunLines(resolution.open)] };
  }
  if (resolution.kind === "none") {
    return {
      code: EXIT_NOT_FOUND,
      lines: [options.runId === undefined
        ? `no non-terminal run in ${PROJECT_WORK_DIR}/`
        : `no run '${options.runId}' in ${PROJECT_WORK_DIR}/`],
    };
  }
  const store = resolution.store;

  // The plan is the list of stories that EXIST — read from the same two files
  // `run status` reads, so an id this refuses is an id nothing could ever run.
  const progress = buildProgress(store.runDir);
  if (progress === null) {
    return refuse([
      `${store.runId} has no plan, so it has no story to widen`,
      `  a story lives in ${PLAN_DIR}/stories/<id>.md or ${BUILD_PHASE}/${IMPLICIT_PLAN_FILE}, and this run has neither`,
    ]);
  }
  const rows = progress.waves.flatMap((wave) => wave.stories.map((s) => ({ ...s, wave: wave.id })));
  const row = rows.find((s) => s.id === id);
  if (row === undefined) {
    return refuse([
      `${store.runId} plans no story \`${id}\``,
      `  it plans ${rows.map((s) => s.id).join(", ")}`,
    ]);
  }

  // ONE source of truth for which states may be widened: `done` is refused
  // because it is absent from `WIDENABLE`, and gets its own sentence because it
  // is the case an operator actually reaches. A second `row.status === "done"`
  // test in front of this set would make the set decorative — adding `done` to it
  // would then change nothing, and the guard would have no teeth to lose.
  if (!WIDENABLE.has(row.status)) {
    if (row.status === "done") {
      return refuse([
        `${id} is \`done\` — refusing to widen the surface of finished work`,
        "  its evidence was written against the surface it DECLARED, and widening it now would make the",
        "  record say the plan declared a path it did not. That is an audit record lying in the direction",
        "  that matters.",
        "  For ONE named defect in that finished work, open a fix round and widen the story it reopens:",
        `  \`tldrx story reopen ${id} --for-fix --note "<the defect>"\`, then \`tldrx story widen ${id} …\`.`,
      ]);
    }
    return refuse([
      `${id} is \`${row.status}\`, which is not a state a story can be widened from`,
      `  widenable: ${[...WIDENABLE].join(", ")}`,
      ...(row.status === "missing"
        ? [`  \`${PLAN_DIR}/stories/${id}.md\` is scheduled in ${row.wave} and not on disk — that is a broken plan, not a narrow one`]
        : []),
    ]);
  }

  const path = progress.implicit
    ? join(store.runDir, BUILD_PHASE, IMPLICIT_PLAN_FILE)
    : join(store.runDir, PLAN_DIR, "stories", `${id}.md`);
  if (!existsSync(path)) {
    return refuse([`${id} is \`${row.status}\` but ${path} is not on disk — refusing to write a file that is not there`]);
  }

  const text = readFileSync(path, "utf8");
  const before = touchesIn(text, progress.implicit);
  if (before === null) {
    return refuse([
      `${id}'s \`touches:\` cannot be read, so there is nothing to widen`,
      `  ${path}`,
      "  a widening is `before` plus the new paths — with no `before` this verb would be REPLACING a list",
      "  it never read, which is a different and far more dangerous edit",
    ]);
  }
  // Compared normalised, WRITTEN verbatim. The declared entries go back to disk
  // exactly as their author wrote them (`docs/` stays `docs/`): this verb adds
  // paths, and rewriting the ones already there would be a second edit nobody
  // asked for.
  const declared = before.map(normalisePath);

  const added: string[] = [];
  for (const candidate of asked) {
    if (declared.includes(candidate) || added.includes(candidate)) {
      return refuse([
        `${id} already declares \`${candidate}\``,
        `  it touches ${before.join(", ")}`,
        "  recording a widening that widened nothing would put a `story.touches_widened` in the log with",
        "  the same list on both sides of it — nothing was written",
      ]);
    }
    added.push(candidate);
  }
  if (before.length + added.length > MAX_TOUCHES) {
    return refuse([
      `${id} would touch ${String(before.length + added.length)} path(s), over the cap of ${String(MAX_TOUCHES)}`,
      `  it declares ${String(before.length)} and this adds ${String(added.length)}`,
      "  a story that touches more than that is not one story — split it, or widen the one that owns the work",
    ]);
  }
  const after = [...before, ...added];

  // Both writes are proved possible before either happens, the same order and for
  // the same reason as `reopenStory`: `--note` is free text, so a note over the
  // §2.9 4KB payload cap would otherwise throw AFTER the story file had been
  // rewritten. Here the event is the one that must not be lost — a `touches:`
  // list that grew with no event is a surface nobody can explain — so the patch
  // is built, the event is validated, and only then does anything touch disk.
  let patched: string;
  try {
    patched = progress.implicit
      ? updateImplicitPlan(text, { touches: after })
      : updateStoryFront(text, { touches: after });
  } catch (error) {
    if (error instanceof StoryWriteError) {
      return refuse([`${id}'s file cannot be updated: ${error.message}`, `  ${path}`]);
    }
    throw error;
  }

  const event = widenEvent(options, store.runId, id, added, before, after);
  const validation = validateEvent(event);
  if (!validation.ok) {
    const first = validation.issues[0];
    return refuse([
      `the story.touches_widened event this would append is not valid: ${first?.path ?? ""} ${first?.message ?? "schema error"}`,
      "  nothing was written — the note is the only free text in it, so it is almost certainly too long",
    ]);
  }

  writeFileSync(path, patched, "utf8");
  store.append(event);

  return {
    code: EXIT_OK,
    lines: [
      `widened ${id} in ${store.runId} — ${String(before.length)} → ${String(after.length)} touched path(s) (${row.wave})`,
      ...added.map((entry) => `  + ${entry}`),
      `  why: ${options.note}`,
      `  its status is unchanged (\`${row.status}\`): no attempt was consumed, nothing was spawned, nothing was spent`,
      "  and the cursor did not move — this verb declares scope, it does not run anything",
      `  the boundary gate re-reads \`touches:\` off disk, so the next evaluation of ${store.runId}'s Build gate`,
      "  simply stops counting these path(s) as outside the declared surface",
      `  recorded as one story.touches_widened — \`tldrx replay ${store.runId}\` shows the list before and after`,
    ],
  };
}

/**
 * The story's declared `touches:`, verbatim, from whichever of the two documents
 * holds it — the story's front matter, or the implicit plan's `story:` block.
 *
 * Null means "there is no readable `touches:` list here", which is not the same
 * as an empty one: `04-build/implicit-plan.yml` legitimately renders `touches: []`
 * with a comment saying why, and that story — whose write surface currently
 * forbids every change — is exactly the one an operator has most reason to widen.
 * A null, by contrast, would make this verb REPLACE a list it never read.
 */
function touchesIn(text: string, implicit: boolean): readonly string[] | null {
  let doc: unknown;
  try {
    doc = implicit ? parseYaml(text) : parseYaml(splitFrontMatter(text).raw);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const holder = implicit ? (doc as { story?: unknown }).story : doc;
  if (holder === null || typeof holder !== "object" || Array.isArray(holder)) return null;
  const value = (holder as { touches?: unknown }).touches;
  if (!Array.isArray(value)) return null;
  if (!value.every((item): item is string => typeof item === "string")) return null;
  return value;
}

function widenEvent(
  options: WidenOptions,
  runId: string,
  storyId: string,
  added: readonly string[],
  before: readonly string[],
  after: readonly string[],
): TldrxEvent {
  return {
    ts: options.at,
    run: runId,
    // The operator acted outside a stage run — the same call `story.reopened`
    // makes. `payload.story` is what carries the story, and it is what every
    // per-story reader of `events.jsonl` filters on.
    stage: null,
    type: "story.touches_widened",
    actor: options.actor,
    cost_usd: 0,
    payload: {
      story: storyId,
      /** What this widening ADDED — the list `before` did not have. */
      paths: [...added],
      note: options.note,
      /**
       * Both ends, because the addition alone cannot be read back. A reader six
       * months later asking "what surface was this story approved over" needs the
       * list as it stood, and re-deriving it by replaying every widening in order
       * is a second reading of one fact.
       */
      before: [...before],
      after: [...after],
    },
  };
}

function refuse(lines: readonly string[]): WidenOutcome {
  return { code: EXIT_REFUSED, lines };
}
