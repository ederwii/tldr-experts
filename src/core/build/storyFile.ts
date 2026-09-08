/**
 * Writing a story's outcome back into `03-plan/stories/<id>.md`.
 *
 * The story file is the Build phase's state, so the executor has to edit it — but
 * it is also a document a human wrote and reads, so it is edited **surgically**:
 * the `status:` line is replaced, and the `evidence:` and `touches:` blocks are
 * rewritten, and every other byte of the front matter, the prose and the ```dod
 * block is left exactly as it was. Round-tripping the YAML would reflow comments
 * and quoting that nobody asked us to touch.
 *
 * Three keys, and only three, because exactly three are STATE that something
 * other than their author writes: `status:` and `evidence:` are what the Build
 * executor records, and `touches:` is what `tldrx story widen` declares (#171).
 * Everything else in the front matter belongs to whoever wrote the story.
 *
 * Only the front matter is scanned. A `status:` inside the body — a line of prose,
 * a line of a dod block — is not the story's status and is never rewritten.
 */
import { splitFrontMatter, FENCE } from "../schemas/frontMatter.ts";
import type { PlanStatus } from "../schemas/planCommon.ts";

export interface StoryPatch {
  readonly status?: PlanStatus;
  /** Replaces the whole list. Spec §2.13: required non-empty at `status: done`. */
  readonly evidence?: readonly string[];
  /**
   * Replaces the whole list, exactly as `evidence` does (#171). `touches` is
   * already required, non-empty and capped at MAX_TOUCHES, so this changes a
   * VALUE and no schema: `STORY_KEYS` is untouched. It lives here, and not in a
   * second writer, so the story file and `04-build/implicit-plan.yml` cannot
   * disagree about what a widened list looks like.
   */
  readonly touches?: readonly string[];
}

const STATUS_RE = /^status\s*:/;
const EVIDENCE_RE = /^evidence\s*:/;
/**
 * Indent-capturing, and `status:`/`evidence:` are not.
 *
 * Measured: in `03-plan/stories/<id>.md` all three keys are front-matter
 * top-level, but in `04-build/implicit-plan.yml` `status:` and `evidence:` stay
 * top-level while `touches:` is nested under `story:` at indent 2
 * (`implicitPlan.ts` renders it through `block()`). One writer serves both
 * documents, so the key's own indentation is read off the line and given back to
 * the block that replaces it — anchoring at column 0 would leave the verb unable
 * to widen the plan a Plan-skipping scope actually runs on.
 */
const TOUCHES_RE = /^(\s*)touches\s*:/;
const LIST_ITEM_RE = /^\s+-\s/;

export class StoryWriteError extends Error {}

/** Apply `patch` to the front matter of `text`, returning the whole file. */
export function updateStoryFront(text: string, patch: StoryPatch): string {
  const split = splitFrontMatter(text);
  if (!split.present) {
    throw new StoryWriteError("the story has no `---` front matter to update");
  }
  const lines = applyPlanPatch(split.raw.split("\n"), patch);
  return [FENCE, ...lines, FENCE, split.body].join("\n");
}

/**
 * The same three surgical edits, over a bare block of YAML lines.
 *
 * Split out because a run whose scope SKIPPED the Plan phase has no
 * `stories/<id>.md` to hold front matter: its state lives in
 * `04-build/implicit-plan.yml`, which is YAML all the way down
 * (`src/core/build/implicitPlan.ts`). One writer, so the two documents cannot
 * disagree about what `status: done` plus an `evidence:` list, or a widened
 * `touches:` list, looks like.
 *
 * Both `replaceEvidence` and `replaceTouches` consume the list items that FOLLOW
 * their key, so whatever key comes next in either document must not be a bare
 * list. `renderImplicitPlan` says the same thing from the other side, and its
 * layout is what makes it true there.
 */
export function applyPlanPatch(input: readonly string[], patch: StoryPatch): string[] {
  let lines = [...input];
  if (patch.status !== undefined) lines = replaceStatus(lines, patch.status);
  if (patch.evidence !== undefined) lines = replaceEvidence(lines, patch.evidence);
  if (patch.touches !== undefined) lines = replaceTouches(lines, patch.touches);
  return lines;
}

function replaceStatus(lines: readonly string[], status: PlanStatus): string[] {
  const out = [...lines];
  const at = out.findIndex((line) => STATUS_RE.test(line));
  if (at === -1) throw new StoryWriteError("the story front matter has no `status:` key");
  out[at] = `status: ${status}`;
  return out;
}

/**
 * Rewrite `evidence:` and the block of list items under it. An empty list is
 * written inline (`evidence: []`) so a not-yet-built story keeps the shape the
 * Plan phase wrote.
 */
function replaceEvidence(lines: readonly string[], evidence: readonly string[]): string[] {
  const out = [...lines];
  const at = out.findIndex((line) => EVIDENCE_RE.test(line));
  if (at === -1) throw new StoryWriteError("the story front matter has no `evidence:` key");
  let end = at + 1;
  while (end < out.length && LIST_ITEM_RE.test(out[end] ?? "")) end++;
  const block = evidence.length === 0
    ? ["evidence: []"]
    : ["evidence:", ...evidence.map((item) => `  - ${quote(item)}`)];
  out.splice(at, end - at, ...block);
  return out;
}

/**
 * Rewrite `touches:` and the block of list items under it (#171). Unlike
 * `evidence`, there is no `[]` shape: spec §2.13 requires a non-empty list, so an
 * empty one is refused here rather than written and refused later by the
 * validator — a story file this wrote and the schema rejects is the framework
 * breaking its own state.
 *
 * The key's own indentation is preserved, and the items are indented two further:
 * the same block shape both documents already carry (`touches: []` inline in a
 * story's front matter, `  touches:` under `story:` in the implicit plan).
 */
function replaceTouches(lines: readonly string[], touches: readonly string[]): string[] {
  if (touches.length === 0) throw new StoryWriteError("a story's `touches:` may not be empty");
  const out = [...lines];
  const at = out.findIndex((line) => TOUCHES_RE.test(line));
  if (at === -1) throw new StoryWriteError("the story front matter has no `touches:` key");
  const indent = TOUCHES_RE.exec(out[at] ?? "")?.[1] ?? "";
  let end = at + 1;
  while (end < out.length && LIST_ITEM_RE.test(out[end] ?? "")) end++;
  out.splice(at, end - at, `${indent}touches:`, ...touches.map((item) => `${indent}  - ${quote(item)}`));
  return out;
}

/**
 * A double-quoted YAML scalar. JSON's escaping is a subset of YAML's, so
 * `JSON.stringify` produces a scalar that reads back byte-identical — including
 * the `→` in a `$ <cmd> → exit 0` evidence line.
 */
export function quote(value: string): string {
  return JSON.stringify(value);
}

/** The evidence spec §2.13 requires of a done story (`$ cmd → exit 0`, sha, review). */
export function evidenceFor(
  dodCommands: readonly string[],
  commitSha: string,
  reviewPath: string,
): readonly string[] {
  return [
    ...dodCommands.map((command) => `$ ${command} → exit 0`),
    `commit ${commitSha}`,
    reviewPath,
  ];
}
