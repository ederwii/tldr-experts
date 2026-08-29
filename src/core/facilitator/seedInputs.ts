/**
 * Seed documents in a stage prompt: which ones, and how much of each.
 *
 * Spec §2.3 says the declared inputs are "the ONLY files the sub-agent gets", and
 * `prompt.ts` honours that by inlining their CONTENT. A seed can be a directory of
 * fifty documents, so two bounds apply:
 *
 *  - **count** — §2.3 caps a stage at 20 inputs. `run new` already caps what it
 *    DECLARES; this caps what actually reaches the prompt, in declaration order.
 *  - **bytes** — a shared inline budget across the seed documents. `seed-index.md`
 *    is exempt: it is the table of contents, it is small, and a prompt that says
 *    "there were 50 documents, here are 3" is honest in a way that silently
 *    dropping 47 is not. When the budget runs out mid-document the prefix is
 *    inlined and labelled; when it runs out entirely the document is listed as
 *    on-disk-only.
 *
 * `[assumption]` — the spec sets no inline budget. 64 KB is roughly 16k tokens,
 * which leaves room for the stage body, the expert bodies and the facts.
 */
import { readFileSync, statSync } from "node:fs";
import { resolveDeclared, type PathContext } from "./paths.ts";
import { MAX_STAGE_INPUTS } from "../run/workflowPreset.ts";
import type { PromptInput } from "./prompt.ts";

export const MAX_SEED_INLINE_BYTES = 64 * 1024;
/** Below this there is no point slicing: a 500-byte prefix teaches nothing. */
const MIN_SLICE_BYTES = 2 * 1024;

export interface InlineResult {
  readonly inputs: readonly PromptInput[];
  /** One line for the `## Inputs` preamble when something was cut, else null. */
  readonly note: string | null;
}

export interface InlineOptions {
  readonly ctx: PathContext;
  /** Declared paths that are seed documents; everything else is inlined whole. */
  readonly seed: ReadonlySet<string>;
  readonly budgetBytes?: number;
  /** Exempt from the budget — the seed's own index. */
  readonly exempt?: ReadonlySet<string>;
}

export function inlineInputs(
  declared: readonly string[],
  options: InlineOptions,
): InlineResult {
  const budget = options.budgetBytes ?? MAX_SEED_INLINE_BYTES;
  const exempt = options.exempt ?? new Set<string>();
  const inputs: PromptInput[] = [];
  let spent = 0;
  let truncated = 0;
  let omitted = 0;

  for (const path of declared) {
    const abs = resolveDeclared(path, options.ctx);
    if (!options.seed.has(path) || exempt.has(path)) {
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
    if (room >= MIN_SLICE_BYTES) {
      spent += room;
      truncated += 1;
      inputs.push({ path, content: slice(abs, room), inlinedBytes: room, totalBytes: size });
      continue;
    }
    omitted += 1;
    inputs.push({ path, content: "", inlinedBytes: 0, totalBytes: size });
  }

  return { inputs, note: describe(budget, truncated, omitted) };
}

function describe(budget: number, truncated: number, omitted: number): string | null {
  if (truncated === 0 && omitted === 0) return null;
  const parts: string[] = [];
  if (truncated > 0) parts.push(`${truncated} document(s) inlined only as far as the budget reached`);
  if (omitted > 0) parts.push(`${omitted} document(s) listed but not inlined`);
  return `The seed is larger than the ${budget}-byte inline budget: ${parts.join(", ")}. `
    + "`seed-index.md` lists every document that was read. Work from what is inlined and say so.";
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
