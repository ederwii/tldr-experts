/**
 * Declared inputs in a stage prompt: which ones, and how much of each.
 *
 * Spec §2.3 says the declared inputs are "the ONLY files the sub-agent gets", and
 * `prompt.ts` honours that by inlining their CONTENT. A seed can be a directory of
 * fifty documents, so two bounds apply:
 *
 *  - **count** — §2.3 caps a stage at 20 inputs. `run new` already caps what it
 *    DECLARES; this caps what actually reaches the prompt, in declaration order.
 *  - **bytes** — ONE shared inline budget across every declared input, spent in
 *    declaration order, which is required inputs, then present optional ones,
 *    then the run's seed documents. `seed-index.md` is exempt: it is the table of
 *    contents, it is small, and a prompt that says "there were 50 documents, here
 *    are 3" is honest in a way that silently dropping 47 is not. When the budget
 *    runs out mid-document the prefix is inlined and labelled; when it runs out
 *    entirely the document is listed as on-disk-only.
 *
 * **Wave N: one budget, inputs first.** Until 2026-08-29 the seed documents had
 * their own 64 KB budget and each loaded expert had its OWN 64 KB of trained
 * knowledge, so the two never competed and the asymmetry was measurable: on
 * `~/aparece-v2` the seed budget dropped `ADR-D013-DELIVERY-ZONE-GEOMETRY.md`
 * (5,863 B) whole — the sixth of the six decisions the run existed to settle —
 * while 70,923 B of expert knowledge nobody had asked for went in untouched. A
 * budget that can drop a DECLARED input while undeclared reference material
 * passes is not a budget; it is two budgets pointed away from each other.
 *
 * So the declared inputs are now filled FIRST, out of `inputs_max_bytes`
 * (§2.3, default 98304), and the experts share `knowledge_max_bytes` TOTAL
 * between them afterwards. Anything the inputs budget still could not fit is
 * named on stdout AND on the page, with the key that would fix it — a truncated
 * input is a fact about the run, not a detail of the renderer.
 *
 * `[assumption]` — the spec sets no inline budget, and 96 KB is not measured. It
 * is the smallest round number above the 77,987 B of declared inputs the aparece
 * regression fixture carries, which is a real seed for a real run.
 */
import { readFileSync, statSync } from "node:fs";
import { resolveDeclared, type PathContext } from "./paths.ts";
import { MAX_STAGE_INPUTS } from "../run/workflowPreset.ts";
import type { PromptInput } from "./prompt.ts";

/**
 * `[assumption]` — the shared ceiling on ALL declared inputs (§2.3
 * `inputs_max_bytes`). Was 64 KB and applied to seed documents alone.
 */
export const DEFAULT_INPUTS_MAX_BYTES = 96 * 1024;

/** Kept as the old name for the old number; nothing in `src/` reads it any more. */
export const MAX_SEED_INLINE_BYTES = 64 * 1024;

/** Below this there is no point slicing: a 500-byte prefix teaches nothing. */
const MIN_SLICE_BYTES = 2 * 1024;

/** One declared input the budget could not fit whole. */
export interface TruncatedInput {
  readonly path: string;
  readonly totalBytes: number;
  /** 0 when nothing of it was inlined at all. */
  readonly inlinedBytes: number;
}

export interface InlineResult {
  readonly inputs: readonly PromptInput[];
  /** One line for the `## Inputs` preamble when something was cut, else null. */
  readonly note: string | null;
  /** Every input the budget cut or dropped, in declaration order. */
  readonly truncated: readonly TruncatedInput[];
  /** Bytes of input CONTENT inlined — what the ledger charges to `inputs`. */
  readonly inlinedBytes: number;
  /** The budget these were filled from, for the ledger and the refusal message. */
  readonly budgetBytes: number;
}

export interface InlineOptions {
  readonly ctx: PathContext;
  /**
   * Declared paths that are seed documents. Wave N stopped using this to decide
   * WHO is budgeted — every declared input is — and keeps it only so the note can
   * say "seed" when a seed is what overflowed.
   */
  readonly seed: ReadonlySet<string>;
  readonly budgetBytes?: number;
  /** Exempt from the budget — the seed's own index. */
  readonly exempt?: ReadonlySet<string>;
}

export function inlineInputs(
  declared: readonly string[],
  options: InlineOptions,
): InlineResult {
  const budget = options.budgetBytes ?? DEFAULT_INPUTS_MAX_BYTES;
  const exempt = options.exempt ?? new Set<string>();
  const inputs: PromptInput[] = [];
  const truncated: TruncatedInput[] = [];
  let spent = 0;
  let seedOverflowed = false;

  for (const path of declared) {
    const abs = resolveDeclared(path, options.ctx);
    if (exempt.has(path)) {
      inputs.push({ path, content: readOrEmpty(abs) });
      continue;
    }
    const size = sizeOf(abs);
    const room = budget - spent;
    if (size <= room) {
      spent += size;
      inputs.push({ path, content: readOrEmpty(abs) });
      continue;
    }
    if (options.seed.has(path)) seedOverflowed = true;
    if (room >= MIN_SLICE_BYTES) {
      spent += room;
      truncated.push({ path, totalBytes: size, inlinedBytes: room });
      inputs.push({ path, content: slice(abs, room), inlinedBytes: room, totalBytes: size });
      continue;
    }
    truncated.push({ path, totalBytes: size, inlinedBytes: 0 });
    inputs.push({ path, content: "", inlinedBytes: 0, totalBytes: size });
  }

  return {
    inputs,
    note: describe(budget, truncated, seedOverflowed),
    truncated,
    inlinedBytes: spent,
    budgetBytes: budget,
  };
}

/**
 * The line the prompt itself carries when an input did not fit.
 *
 * It names every file and its size, because "some documents were truncated" is a
 * sentence the sub-agent can do nothing with, and it names the KEY that raises the
 * budget, because the operator reading it over the agent's shoulder can.
 */
function describe(
  budget: number,
  truncated: readonly TruncatedInput[],
  seedOverflowed: boolean,
): string | null {
  if (truncated.length === 0) return null;
  const listed = truncated
    .map((entry) => `${entry.path} (${entry.totalBytes.toLocaleString("en-US")} B`
      + `${entry.inlinedBytes === 0 ? ", none inlined" : `, first ${entry.inlinedBytes.toLocaleString("en-US")} B only`})`)
    .join("; ");
  const fix = seedOverflowed
    ? "raise `inputs_max_bytes` in the stage file or split the seed (`tldrx seed triage`)"
    : "raise `inputs_max_bytes` in the stage file";
  return `truncated inputs: ${listed} — the ${budget.toLocaleString("en-US")}-byte `
    + `\`inputs_max_bytes\` budget ran out. ${fix}. `
    + "Work from what IS inlined and say in your handoff what you could not read.";
}

/** The same sentence for stdout, one line per truncated input. */
export function describeTruncatedInputs(result: InlineResult): readonly string[] {
  return result.truncated.map((entry) =>
    `truncated input: ${entry.path} (${entry.totalBytes.toLocaleString("en-US")} B`
    + `${entry.inlinedBytes === 0 ? ", none inlined" : `, ${entry.inlinedBytes.toLocaleString("en-US")} B inlined`})`
    + ` — raise inputs_max_bytes (now ${result.budgetBytes.toLocaleString("en-US")}) or split the seed`);
}

/** Declaration order, capped at the §2.3 input limit. */
export function capInputs(declared: readonly string[], max = MAX_STAGE_INPUTS): readonly string[] {
  return declared.length <= max ? declared : declared.slice(0, max);
}

function sizeOf(abs: string): number {
  try {
    return statSync(abs).size;
  } catch {
    return 0;
  }
}

function slice(abs: string, bytes: number): string {
  try {
    return readFileSync(abs).subarray(0, bytes).toString("utf8");
  } catch {
    return "";
  }
}

function readOrEmpty(abs: string): string {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}
