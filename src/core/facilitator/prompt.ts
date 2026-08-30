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
 *   1. `stage.md`            the stage's own rules; one file, per stage
 *   2. expert blocks         `expert.md` + trained knowledge; the big stable mass
 *   3. `## Inputs`           the declared inputs' content; per stage
 *   4. `## Previous attempt` the retry note and the refused outputs; per attempt
 *
 * strictly most-stable to least-stable. `## Inputs` and `## Previous attempt` are
 * CUT out of `stage.md` wherever its author put them and re-emitted at the tail,
 * so a spec-shaped stage file with `## Inputs` in the middle produces exactly one
 * of that heading and it is at the end. Nothing is duplicated and nothing that a
 * stage author wrote under those two headings survived before either: the old
 * assembly replaced their bodies outright.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { isRetired, type Fact } from "../facts/Fact.ts";
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

export interface PromptParts {
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
   * Why this stage is being run again — a previous failure, an operator's reject
   * note, or both. Empty on a first attempt, and then no section is emitted at
   * all: a heading saying "nothing went wrong last time" is noise in every prompt.
   */
  readonly previousAttempt?: string;
}

export const INPUTS_HEADING = "Inputs";
export const PREVIOUS_ATTEMPT_HEADING = "Previous attempt";

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
    cutSection(substitute(parts.stageMd, parts.values), INPUTS_HEADING),
    PREVIOUS_ATTEMPT_HEADING,
  );
  const out: PromptPart[] = [
    { kind: "stage", name: "stage.md", text: `${substituted.trimEnd()}\n` },
  ];

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
    text: `\n## ${INPUTS_HEADING}\n\n${renderInputs(parts.inputs, parts.inputsNote).trimEnd()}\n`,
  });

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
  | "stage" | "expert-body" | "expert-knowledge" | "inputs" | "previous-attempt";

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

export function renderInputs(inputs: readonly PromptInput[], note?: string): string {
  if (inputs.length === 0) {
    return "_No input files are declared for this stage. Do not go looking for others._";
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
  return out.join("\n");
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
 * `area` field in either shape, so the filter is the repo half only: a non-retired
 * fact scoped to a repo in this run, or scoped to none at all (workspace-wide).
 */
export function renderFacts(facts: readonly Fact[], repos: readonly string[]): string {
  const relevant = facts.filter(
    (fact) => !isRetired(fact) && (fact.repos.length === 0 || fact.repos.some((r) => repos.includes(r))),
  );
  if (relevant.length === 0) return "_No recorded facts match this run's repos._";
  return relevant
    .map((fact) => `- [${fact.id}] ${fact.fact} (${fact.area} · ${fact.confidence})`)
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

