/**
 * Prompt assembly (spec §2.3, §5).
 *
 * "Placeholders `{{run}} {{repos}} {{inputs}} {{facts}} {{conventions}}
 * {{budget_usd}}` are substituted by the facilitator, never by the model." That
 * sentence is the whole design: the sub-agent is handed a finished document, not
 * a template plus permission to go find things. Its `## Inputs` section carries
 * the CONTENT of the declared inputs and nothing else, so "read nothing else" is
 * a statement about what is physically in the prompt rather than a request.
 *
 * **Order is a cost decision, not a layout one (wave N).** A prompt cache keys on
 * the longest PREFIX two calls share: a cache write is billed at 1.25x an input
 * token and a cache read at 0.1x, so whatever is stable belongs at the front and
 * whatever changes belongs at the back. Measured 2026-08-29 on `~/aparece-v2`,
 * the What prompt was 159,575 B of which 52% was expert bodies + trained
 * knowledge — the most stable material in the document — and it was emitted LAST,
 * behind 45% of declared inputs that change at every stage. So the order is now:
 *
 *   0. the preamble          the imperative: who the reader is, what to write, where (gh #196)
 *   1. `stage.md`            the stage's own rules; one file, per stage
 *   2. expert blocks         `expert.md` + trained knowledge; the big stable mass
 *   3. `## Inputs`           the declared inputs' content; per stage
 *   4. `## Dispatch notes`   the host's own context for THIS cycle; per cycle
 *   5. `## Project skills`   the project's own `.claude/skills`, named; per workspace
 *   6. `## Previous attempt` the retry note and the refused outputs; per attempt
 *
 * strictly most-stable to least-stable. The dispatch-notes slot
 * (`facilitator/dispatchNotes.ts`) is the most volatile thing in the document —
 * a human writes it between one cycle and the next — so it goes behind the
 * inputs and never ahead of the expert blocks, where it would pay the
 * cache-WRITE price on the largest stable section of every stage.
 *
 * `## Project skills` is the one entry the stability order does not explain by
 * itself: it is workspace-stable and still sits BEHIND the per-cycle notes. It is
 * emitted only when a project has skills at all, so putting it ahead of the notes
 * would shift their offset in every prompt of every workspace that has any — a
 * cache write on a few hundred bytes, to save one on the same few hundred. Behind
 * the notes it costs nothing, and it stays ahead of the retry note, which is the
 * one thing in the document that changes within a single stage.
 *
 * All four of `## Inputs`, `## Dispatch notes`, `## Project skills` and
 * `## Previous attempt` are CUT out of `stage.md` wherever its author put them and
 * re-emitted at the tail, so a spec-shaped stage file with `## Inputs` in the
 * middle produces exactly one of that heading and it is at the end. Nothing is
 * duplicated and nothing that a stage author wrote under those headings survived
 * before either: the old assembly replaced their bodies outright.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { DISPATCH_NOTES_HEADING } from "./dispatchNotes.ts";
import { PROJECT_SKILLS_HEADING } from "../experts/stackPacks.ts";
import { isLive, type Fact } from "../facts/Fact.ts";
import { stackExpertNames } from "../experts/stackExperts.ts";

export { stackExpertNames };

export const PLACEHOLDERS = ["run", "repos", "inputs", "facts", "conventions", "budget_usd"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

/** One declared input, already read from disk. */
export interface PromptInput {
  readonly path: string;
  readonly content: string;
  /**
   * Set only when the file was inlined in part (a seed document over the inline
   * budget): how many bytes of `totalBytes` are in `content`. The prompt says so
   * rather than presenting a prefix as the whole document.
   */
  readonly inlinedBytes?: number;
  readonly totalBytes?: number;
  /**
   * Build only: the path is not tracked at the story branch's base, so the
   * worktree the sub-agent works in has no copy of it and no amount of reading
   * will produce one. Different from "the budget dropped it" in the one way that
   * matters to the agent: "read it at that path" is advice it cannot take.
   */
  readonly notInWorktree?: boolean;
}

/**
 * True when NOTHING of this input's content is in the prompt.
 *
 * The one predicate behind the `## Inputs` preamble and the per-file block, so
 * the header's count and the blocks below it cannot disagree — which is exactly
 * the bug: a prompt that inlined 9 of 15 declared inputs still opened with "their
 * full content is inlined below, so there is nothing to open".
 */
export function isNotInlined(input: PromptInput): boolean {
  if (input.notInWorktree === true) return true;
  return input.totalBytes !== undefined && (input.inlinedBytes ?? 0) === 0;
}

/**
 * What the imperative preamble needs, and nothing else: DATA the facilitator
 * already owns (`pending.outputs`, the run id, the stage id), never a context
 * object. One renderer, in one place — the Build developer and reviewer prompts
 * have their own preamble (`core/build/prompts.ts`) and are a different document.
 */
export interface StagePreamble {
  /** The stage id — `what`, `how`, `plan`, `watch`. */
  readonly stage: string;
  readonly run: string;
  /**
   * Every declared output, as a path the sub-agent can write VERBATIM from its
   * cwd. A pattern (`03-plan/stories/<id>.md`) stays a pattern: that shape is
   * exactly what the stage is being told to produce.
   */
  readonly outputs: readonly string[];
}

/**
 * The first words of the prompt, and the sentence the whole part exists for:
 * grep this to prove a spawned stage was told it was one. Tests assert THIS
 * export rather than an English phrase they typed themselves.
 */
export const STAGE_PREAMBLE_MARKER = "You are the tldrx stage sub-agent";

/**
 * The imperative the sub-agent used not to get (gh #196).
 *
 * Measured on a real workspace at 0.13.0: a What agent was handed 66,452 bytes
 * and answered "I don't see an actual request in your message — only system
 * context, tldrx state, and template/expert file dumps". It was right. The first
 * part of the prompt was `stage.md`, which is a fill-in HANDOFF TEMPLATE: it
 * describes a finished document without ever saying that writing that document
 * is the job. The one imperative-shaped sentence in the model's window came from
 * the SessionStart hook, and that is the one the agent answered.
 *
 * So: who the reader is, which stage and run, that the template is to be FILLED,
 * where the result goes, and that a question goes in the questions file rather
 * than back to a human who is not there. Generated from data — no stage is named
 * in this file — and deliberately short: it sits ahead of the largest stable
 * block in the document, where every byte is paid at the cache-WRITE price.
 */
export function renderStagePreamble(preamble: StagePreamble): string {
  const questions = preamble.outputs.find((path) => path.split("/").pop() === QUESTIONS_FILE);
  const lines = [
    `${STAGE_PREAMBLE_MARKER} for stage \`${preamble.stage}\` of run \`${preamble.run}\`.`,
    "This prompt is the entire request: there is no other message to find, and no operator to reply to.",
    "",
    "Do this now:",
    "",
    "1. Fill in the template below — replace every `<…>` placeholder with real, sourced content, and keep the sections it declares.",
    "2. Write the result to the files this stage declares, all of them, at exactly these paths:",
    ...preamble.outputs.map((path) => `   - \`${path}\``),
    questions === undefined
      ? "3. Do not reply with a question. Record anything you cannot settle as an explicit unknown inside the outputs above."
      : `3. Do not reply with a question. Record anything you cannot settle in \`${questions}\`, in the shape the template gives.`,
  ];
  return lines.join("\n");
}

/** The declared output a stage asks its questions in, by convention (spec §2.8). */
const QUESTIONS_FILE = "questions.md";

export interface PromptParts {
  /**
   * The imperative brief, emitted BEFORE `stage.md`. Absent ⇒ no part at all and
   * a byte-identical prompt, which is what every caller that is not a stage spawn
   * (and every older test) relies on.
   */
  readonly preamble?: StagePreamble;
  /** `stage.md`, verbatim. */
  readonly stageMd: string;
  readonly values: Readonly<Record<Placeholder, string>>;
  /**
   * `expert.md` bodies, in load order, each with the star chart and trained
   * knowledge that `src/core/experts/expertBundle.ts` rendered for it (spec §5).
   * `knowledge` is empty for an expert that has never been trained.
   */
  readonly experts: readonly {
    readonly name: string;
    readonly body: string;
    readonly knowledge?: string;
  }[];
  /** Declared input path -> file content, already read from disk. */
  readonly inputs: readonly PromptInput[];
  /** Prepended to `## Inputs` when something was cut to fit (see `seedInputs.ts`). */
  readonly inputsNote?: string;
  /**
   * Declared inputs that resolve to NOTHING — the stage asked for them and no file
   * on either base answers (gh #131).
   *
   * They cannot be carried in `inputs` because there is no content to carry, and
   * dropping them was the bug: `stages/how/stage.yml` declared
   * `.tldrx/map/architecture.md`, `tldrx init` writes `.tldrx/map/<repo>/…`, and
   * two stages of every feature run silently had no map. An absence this framework
   * knows about is stated, in the `absent:` grammar §2.8 already gives a handoff
   * for sourcing a negative claim — never performed.
   */
  readonly absentInputs?: readonly string[];
  /**
   * The rendered body of `## Dispatch notes` — the host's own context for this
   * cycle, already read and capped by `loadDispatchNotes`. Empty when the
   * operator left no file, and then no section is emitted at all.
   */
  readonly dispatchNotes?: string;
  /**
   * The rendered body of `## Project skills` — the project's own Claude skills, named
   * (`experts/stackPacks.ts renderProjectSkills`). Empty when there are none, and then
   * no section is emitted. Independent of the stack-packs switch.
   */
  readonly projectSkills?: string;
  /**
   * Why this stage is being run again — a previous failure, an operator's reject
   * note, or both. Empty on a first attempt, and then no section is emitted at
   * all: a heading saying "nothing went wrong last time" is noise in every prompt.
   */
  readonly previousAttempt?: string;
}

export const INPUTS_HEADING = "Inputs";
export const PREVIOUS_ATTEMPT_HEADING = "Previous attempt";
export { DISPATCH_NOTES_HEADING, PROJECT_SKILLS_HEADING };

export function buildPrompt(parts: PromptParts): string {
  return renderParts(parts).map((part) => part.text).join("");
}

/**
 * The prompt as its ordered pieces, so `assemblePrompt` can weigh each one
 * without re-deriving where the boundaries are. Concatenated, this IS the prompt:
 * `buildPrompt` is one `join("")` over it, and the context ledger measures the
 * same array. One assembly, two readers — a ledger computed from a second,
 * parallel notion of "section" would drift the first time either changed.
 */
export function renderParts(parts: PromptParts): readonly PromptPart[] {
  const substituted = cutSection(
    cutSection(
      cutSection(
        cutSection(substitute(parts.stageMd, parts.values), INPUTS_HEADING),
        DISPATCH_NOTES_HEADING,
      ),
      PROJECT_SKILLS_HEADING,
    ),
    PREVIOUS_ATTEMPT_HEADING,
  );
  const out: PromptPart[] = [];
  if (parts.preamble !== undefined) {
    out.push({
      kind: "preamble",
      name: "preamble",
      text: `${renderStagePreamble(parts.preamble)}\n\n---\n`,
    });
  }
  out.push({ kind: "stage", name: "stage.md", text: `${substituted.trimEnd()}\n` });

  for (const expert of parts.experts) {
    out.push({
      kind: "expert-body",
      name: expert.name,
      text: `\n---\n\n<!-- expert: ${expert.name} -->\n${expert.body.trimEnd()}\n`,
    });
    const knowledge = (expert.knowledge ?? "").trim();
    if (knowledge !== "") {
      out.push({ kind: "expert-knowledge", name: expert.name, text: `\n${knowledge}\n` });
    }
  }

  out.push({
    kind: "inputs",
    name: INPUTS_HEADING,
    text: `\n## ${INPUTS_HEADING}\n\n${renderInputs(parts.inputs, parts.inputsNote, parts.absentInputs).trimEnd()}\n`,
  });

  // Between `## Inputs` and `## Previous attempt` (spec §5). Never substituted:
  // `{{run}}` inside a host's note is the host's own text, not a placeholder the
  // facilitator owns, and this section is context rather than configuration.
  const dispatch = (parts.dispatchNotes ?? "").trim();
  if (dispatch !== "") {
    out.push({
      kind: "dispatch-notes",
      name: DISPATCH_NOTES_HEADING,
      text: `\n## ${DISPATCH_NOTES_HEADING}\n\n${dispatch}\n`,
    });
  }

  // Behind the notes and ahead of the retry note: what this project's skills ARE changes
  // only when a skill is added, so it is the more stable of the two tail sections.
  const skills = (parts.projectSkills ?? "").trim();
  if (skills !== "") {
    out.push({
      kind: "project-skills",
      name: PROJECT_SKILLS_HEADING,
      text: `\n## ${PROJECT_SKILLS_HEADING}\n\n${skills}\n`,
    });
  }

  const previous = (parts.previousAttempt ?? "").trim();
  if (previous !== "") {
    out.push({
      kind: "previous-attempt",
      name: PREVIOUS_ATTEMPT_HEADING,
      text: `\n## ${PREVIOUS_ATTEMPT_HEADING}\n\n${previous}\n`,
    });
  }
  return out;
}

export type PromptPartKind =
  | "preamble" | "stage" | "expert-body" | "expert-knowledge" | "inputs" | "dispatch-notes" | "project-skills"
  | "previous-attempt";

export interface PromptPart {
  readonly kind: PromptPartKind;
  /** `stage.md`, an expert name, or the heading — what the ledger prints. */
  readonly name: string;
  readonly text: string;
}

/** Every `{{name}}` we own; anything else is left alone rather than blanked. */
export function substitute(text: string, values: Readonly<Record<Placeholder, string>>): string {
  return text.replace(/\{\{([a-z_]+)\}\}/g, (whole, name: string) =>
    (PLACEHOLDERS as readonly string[]).includes(name) ? values[name as Placeholder] : whole,
  );
}

/**
 * Replace the body of an H2 section, keeping the heading. When the section does
 * not exist — every DRAFT `stage.md` in this repo is missing `## Inputs` — it is
 * appended, because a prompt without its inputs is not a prompt.
 */
export function replaceSection(markdown: string, heading: string, body: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return `${markdown.trimEnd()}\n\n## ${heading}\n\n${body.trimEnd()}\n`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if ((lines[i] ?? "").startsWith("## ")) {
      end = i;
      break;
    }
  }
  const head = lines.slice(0, start + 1);
  const tail = lines.slice(end);
  return [...head, "", body.trimEnd(), "", ...tail].join("\n");
}

/**
 * Remove an H2 section — heading and body — and return what is left.
 *
 * The inverse of `replaceSection` for the two headings the facilitator OWNS.
 * A stage author who wrote prose under `## Inputs` never had it survive: the old
 * assembly replaced that body with the rendered inputs. Cutting it and re-emitting
 * the section at the tail loses exactly the same bytes and gains a stable prefix.
 */
export function cutSection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return markdown;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if ((lines[i] ?? "").startsWith("## ")) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

export function renderInputs(
  inputs: readonly PromptInput[],
  note?: string,
  absent: readonly string[] = [],
): string {
  if (inputs.length === 0) {
    const none = "_No input files are declared for this stage. Do not go looking for others._";
    return absent.length === 0 ? none : [none, "", ...absentBlocks(absent)].join("\n").trimEnd();
  }
  const out = [...preamble(inputs)];
  const trimmed = (note ?? "").trim();
  if (trimmed !== "") out.push(`**${trimmed}**`, "");

  for (const input of inputs) {
    const fence = fenceFor(input.content);
    out.push(`### \`${input.path}\``, "");
    if (input.notInWorktree === true) {
      out.push(`_${NOT_IN_WORKTREE} It is not committed at this branch's base, so the path above cannot be opened here._`, "");
      continue;
    }
    if (input.totalBytes !== undefined && (input.inlinedBytes ?? 0) === 0) {
      out.push(
        `_Not inlined: ${input.totalBytes} bytes, past this stage's inline budget. `
        + "It exists on disk; READ it at the path above before relying on it — do not guess._",
        "",
      );
      continue;
    }
    if (input.totalBytes !== undefined && input.inlinedBytes !== undefined) {
      out.push(
        `_First ${input.inlinedBytes} of ${input.totalBytes} bytes only — the rest was not inlined._`,
        "",
      );
    }
    out.push(`${fence}`, input.content.replace(/\n$/, ""), `${fence}`, "");
  }
  out.push(...absentBlocks(absent));
  return out.join("\n");
}

/** The heading the absent declared inputs are listed under. */
export const ABSENT_INPUTS_HEADING = "Declared, but not on disk";

/**
 * The declared inputs nothing resolves to, said out loud (gh #131).
 *
 * Named rather than dropped, for the same reason `preamble` names the inputs the
 * byte budget could not inline and `priorOutputs` names the outputs it could not
 * re-show: a sub-agent that is not told what is missing cannot tell "the map says
 * nothing about this" from "I was never shown the map", and its handoff records
 * the second as the first. The `absent:` token is spelled here so the citation the
 * agent needs is a copy rather than a recollection.
 */
function absentBlocks(absent: readonly string[]): readonly string[] {
  if (absent.length === 0) return [];
  const out = [`### ${ABSENT_INPUTS_HEADING}`, ""];
  out.push(
    "This stage declared the paths below and NOTHING resolves to them. There is no",
    "content for them anywhere, so do not reconstruct it and do not treat their",
    "subject as settled. A claim that needs one of them is a negative claim, and it",
    "is sourced with that path's own `absent:` token:",
    "",
  );
  for (const path of absent) out.push(`- \`${path}\` — cite as \`[src: absent:${path}]\``);
  out.push("");
  return out;
}

/** The flag on an input the story's own worktree has no copy of. */
export const NOT_IN_WORKTREE =
  "NOT in this worktree — its content is only what the handoff quotes.";

/**
 * The two sentences `## Inputs` can open with, and the rule for which.
 *
 * "Their full content is inlined below, so there is nothing to open and nothing
 * else to find" is TRUE only when it is true. Measured on a real Build prompt,
 * 2026-08-30: 9 of 15 declared inputs were inlined, the other 6 carried "It
 * exists on disk; do not guess at its content" — and the two documents the run
 * existed to edit were among the six. The preamble and the blocks below it
 * contradicted each other, and the preamble is the one the agent believed.
 */
export function preamble(inputs: readonly PromptInput[]): readonly string[] {
  const missing = inputs.filter(isNotInlined);
  if (missing.length === 0) {
    return [
      "These files are the ONLY ones you may read. Their full content is inlined below,",
      "so there is nothing to open and nothing else to find.",
      "",
    ];
  }
  const listed = missing
    .map((input) => `${input.path}${input.notInWorktree === true ? " (NOT in this worktree)" : ""}`)
    .join(", ");
  return [
    `Inlined below: ${String(inputs.length - missing.length)} of ${String(inputs.length)} declared inputs.`,
    "The rest exist on disk — READ them at the listed paths before relying on them; do not",
    `guess: ${listed}`,
    "",
  ];
}

/** A fence long enough that the file's own backticks cannot close it. */
export function fenceFor(content: string): string {
  let longest = 2;
  for (const match of content.matchAll(/^\s*(`{3,})/gm)) {
    longest = Math.max(longest, (match[1] ?? "").length);
  }
  return "`".repeat(longest + 1);
}

/**
 * `{{facts}}` — spec §5 renders `grep(facts.yml, sy.area/r.repos)`. A stage has no
 * `area` field in either shape, so the filter is the repo half only: a LIVE fact
 * (neither retired nor superseded) scoped to a repo in this run, or scoped to none
 * at all (workspace-wide). A superseded fact is what the workspace used to
 * believe; putting it in a prompt is handing a sub-agent a reversed decision.
 *
 * `decided_by`, when the fact carries it, is appended as `· decided by owner` /
 * `· decided by driver` — this is the ONE place a prompt sees it. Without it,
 * `--decided-by driver` (task 5's required flag, precisely because a driver's
 * default must never be read as the owner's) reaches every downstream prompt
 * indistinguishable from an owner ruling, which is the mistake the flag exists to
 * prevent. Absent, the line is unchanged from before the field existed.
 *
 * `conflicts_with` is rendered here too, and this is likewise the ONE place a
 * prompt sees it (#169): a sub-agent handed two facts that were DETECTED to
 * disagree is told so instead of being left to pick one. Absent means "not
 * detected" — never "checked and agreed" — because the detection is lexical
 * (`conflictOf`, Jaccard ≥ 0.6 inside one `area`) and cannot see two
 * differently-titled answers that contradict.
 */
export function renderFacts(facts: readonly Fact[], repos: readonly string[]): string {
  const relevant = facts.filter(
    (fact) => isLive(fact) && (fact.repos.length === 0 || fact.repos.some((r) => repos.includes(r))),
  );
  if (relevant.length === 0) return "_No recorded facts match this run's repos._";
  return relevant
    .map((fact) => {
      const decidedBy = fact.source.decided_by === undefined ? "" : ` · decided by ${fact.source.decided_by}`;
      // Detected contradictions, named — a prompt handed both facts is told they
      // disagree instead of being left to pick one.
      const conflicts = fact.conflicts_with === undefined || fact.conflicts_with.length === 0
        ? ""
        : ` · conflicts with ${fact.conflicts_with.join(", ")}`;
      return `- [${fact.id}] ${fact.fact} (${fact.area} · ${fact.confidence})${decidedBy}${conflicts}`;
    })
    .join("\n");
}

/**
 * `{{conventions}}` — `[assumption]`: the shared file plus one per repo in the
 * run, which is exactly what `tldrx init` writes (`src/core/init/conventions.ts`).
 * Content, not paths: the sub-agent may only read its declared inputs, so a
 * pointer to a file it is not allowed to open would be useless.
 */
export function renderConventions(root: string, repos: readonly string[]): string {
  const files = ["shared.md", ...repos.map((repo) => `${repo}.md`)];
  const chunks: string[] = [];
  for (const name of files) {
    const path = join(root, PROJECT_FRAMEWORK_DIR, "conventions", name);
    if (!existsSync(path)) continue;
    chunks.push(`<!-- ${PROJECT_FRAMEWORK_DIR}/conventions/${name} -->\n${readFileSync(path, "utf8").trimEnd()}`);
  }
  return chunks.length === 0 ? "_No conventions files exist yet._" : chunks.join("\n\n");
}

/** `.tldrx/experts/<name>/expert.md`, skipping the ones that do not exist. */
export function loadExpertBodies(
  root: string,
  names: readonly string[],
): readonly { name: string; body: string }[] {
  const bodies: { name: string; body: string }[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const path = join(root, PROJECT_FRAMEWORK_DIR, "experts", name, "expert.md");
    if (!existsSync(path)) continue;
    bodies.push({ name, body: readFileSync(path, "utf8") });
  }
  return bodies;
}

