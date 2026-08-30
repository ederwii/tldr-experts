/**
 * Writing a story's outcome back into `03-plan/stories/<id>.md`.
 *
 * The story file is the Build phase's state, so the executor has to edit it — but
 * it is also a document a human wrote and reads, so it is edited **surgically**:
 * the `status:` line is replaced and the `evidence:` block is rewritten, and every
 * other byte of the front matter, the prose and the ```dod block is left exactly
 * as it was. Round-tripping the YAML would reflow comments and quoting that nobody
 * asked us to touch.
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
}

const STATUS_RE = /^status\s*:/;
const EVIDENCE_RE = /^evidence\s*:/;
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
 * The same two surgical edits, over a bare block of YAML lines.
 *
 * Split out because a run whose scope SKIPPED the Plan phase has no
 * `stories/<id>.md` to hold front matter: its state lives in
 * `04-build/implicit-plan.yml`, which is YAML all the way down
 * (`src/core/build/implicitPlan.ts`). One writer, so the two documents cannot
 * disagree about what `status: done` plus an `evidence:` list looks like.
 */
export function applyPlanPatch(input: readonly string[], patch: StoryPatch): string[] {
  let lines = [...input];
  if (patch.status !== undefined) lines = replaceStatus(lines, patch.status);
  if (patch.evidence !== undefined) lines = replaceEvidence(lines, patch.evidence);
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
