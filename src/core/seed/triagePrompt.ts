/**
 * The one prompt `tldrx seed triage --propose` pays for (spec §6.2).
 *
 * Two rules shape it. **Everything the model is allowed to use is in it** — the
 * deterministic inventory and the documents themselves, nothing to go and fetch —
 * which is the same contract §2.3 gives a stage's declared inputs. And **what was
 * cut is named**: a document inlined as headings plus its first 2 KB says so, by
 * name, with its real byte count, because a model that thinks it read a 152 KB
 * design document and read 2 KB of it will propose a split with great confidence.
 *
 * Budget arithmetic, in one place so it can be checked: if every document fits in
 * the byte budget they all go in whole. If not, a quarter of the budget is
 * reserved for digests, the small documents are inlined whole (ascending by size,
 * so the budget buys the most documents it can), and everything left gets its
 * headings plus a 2 KB prefix while the reserve lasts — headings only after that.
 */
import type { SeedDocument, SeedSet } from "./collectSeed.ts";
import type { SeedInventory } from "./triageInventory.ts";
import { formatTokens, verdictLine } from "./triageInventory.ts";
import { SPLIT_SIZES } from "./splitFile.ts";

/** `[assumption]` — the spec sets no budget. 120 KB is roughly 30k tokens of seed. */
export const DEFAULT_PROMPT_BYTES = 120 * 1024;
/** How much of a too-large document is worth showing. Under this a prefix teaches nothing. */
export const DIGEST_BYTES = 2 * 1024;
const DIGEST_RESERVE = 0.25;

export interface InlinedDocument {
  readonly rel: string;
  readonly bytes: number;
  /** What went into the prompt. */
  readonly text: string;
  readonly whole: boolean;
  /** Bytes of body actually inlined (0 for a headings-only entry). */
  readonly inlinedBytes: number;
  /**
   * Every `#`/`##`/`###` line of the WHOLE document, for a truncated one.
   *
   * From the whole document on purpose: the headings are the map, and a map of
   * the first 2 KB of a 152 KB document is the wrong map, drawn confidently.
   */
  readonly headings: readonly string[];
}

export interface TriagePromptPlan {
  readonly documents: readonly InlinedDocument[];
  readonly budgetBytes: number;
  readonly spentBytes: number;
  readonly truncated: readonly string[];
}

export function planInline(seed: SeedSet, budgetBytes = DEFAULT_PROMPT_BYTES): TriagePromptPlan {
  const total = seed.documents.reduce((sum, document) => sum + document.bytes, 0);
  const byRel = [...seed.documents].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  if (total <= budgetBytes) {
    return {
      documents: byRel.map((document) => whole(document)),
      budgetBytes,
      spentBytes: total,
      truncated: [],
    };
  }

  const wholeBudget = Math.floor(budgetBytes * (1 - DIGEST_RESERVE));
  const bySize = [...seed.documents].sort((a, b) =>
    a.bytes === b.bytes ? (a.rel < b.rel ? -1 : 1) : a.bytes - b.bytes);

  const inlinedWhole = new Set<string>();
  let spent = 0;
  for (const document of bySize) {
    if (spent + document.bytes > wholeBudget) continue;
    spent += document.bytes;
    inlinedWhole.add(document.rel);
  }

  let reserve = budgetBytes - spent;
  const documents: InlinedDocument[] = [];
  const truncated: string[] = [];
  for (const document of byRel) {
    if (inlinedWhole.has(document.rel)) {
      documents.push(whole(document));
      continue;
    }
    const take = Math.min(DIGEST_BYTES, Math.max(0, reserve));
    reserve -= take;
    spent += take;
    documents.push({
      rel: document.rel,
      bytes: document.bytes,
      text: take === 0 ? "" : document.text.slice(0, take),
      whole: false,
      inlinedBytes: take,
      headings: headingLines(document.text),
    });
    truncated.push(
      take === 0
        ? `${document.rel}: headings only (0 of ${String(document.bytes)} bytes inlined)`
        : `${document.rel}: headings + the first ${String(take)} of ${String(document.bytes)} bytes`,
    );
  }
  return { documents, budgetBytes, spentBytes: spent, truncated };
}

function whole(document: SeedDocument): InlinedDocument {
  return {
    rel: document.rel, bytes: document.bytes, text: document.text,
    whole: true, inlinedBytes: document.bytes, headings: [],
  };
}

export interface TriagePromptInput {
  readonly inventory: SeedInventory;
  readonly seed: SeedSet;
  readonly seedPath: string;
  /** Every workflow stem on disk — the only legal `scope` in the answer. */
  readonly scopes: readonly string[];
  readonly budgetUsd: number;
  readonly promptBytes?: number;
  /** Where a `--prepare` host session must write the proposal. Omitted for headless. */
  readonly proposalPath?: string;
}

export function triagePrompt(input: TriagePromptInput): string {
  const plan = planInline(input.seed, input.promptBytes ?? DEFAULT_PROMPT_BYTES);
  const inventory = input.inventory;

  const lines: string[] = [
    `# Seed triage — ${inventory.source}`,
    "",
    "## Role",
    "You are a delivery planner. You are given one team's requirement documents and",
    "you decide how they divide into separate pieces of work. You do not design, you",
    "do not write code, and you do not create anything: you propose, a human decides.",
    "",
    "## Objective",
    `Split this seed into runs. ${verdictLine(inventory, input.seedPath)}`,
    "",
    "A run is one coherent piece of work with its own budget and its own branch. Good",
    "runs are the ones a different person could pick up without reading the others;",
    "the documents that must be read together belong in the same run, and a document",
    "several runs need goes in `shared_context` instead of being repeated.",
    "",
    "## The inventory (deterministic — measured, not guessed)",
    "",
    `${String(inventory.files)} document(s), ${String(inventory.bytes)} bytes, `
      + `${formatTokens(inventory.tokens)} tokens.`,
    "",
    "| Document | Bytes | ~Tokens | H2 headings | References | Status | Open markers | Code-derived |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const document of inventory.documents) {
    lines.push(
      `| \`${document.rel}\` | ${String(document.bytes)} | ${String(document.tokens)} | `
      + `${String(document.h2.length)} | `
      + `${document.references.length === 0 ? "—" : document.references.map((rel) => `\`${rel}\``).join(" ")} | `
      + `${document.adrStatus ?? "—"} | ${String(document.openMarkers)} | `
      + `${document.codeDerived.likely ? `likely (${String(document.codeDerived.resolved)} paths resolve)` : "no"} |`,
    );
  }
  lines.push("");
  lines.push(
    "`Code-derived: likely` means the document cites paths that exist in this",
    "workspace's repos — the code says the same thing and can be read directly, so",
    "such a document is usually a candidate for `exclude`, not for a run's seeds.",
    "A `Status` of `superseded`, `rejected` or `draft` is a reason to exclude it and",
    "say so. Documents with open markers carry unsettled decisions: turn each into a",
    "`questions` entry rather than picking an answer yourself.",
    "",
  );
  if (inventory.skipped.length > 0) {
    lines.push("Not read at all (over a bound):", "");
    for (const entry of inventory.skipped) lines.push(`- \`${entry.rel}\` — ${entry.reason}`);
    lines.push("");
  }

  lines.push("## Scopes you may use", "", `\`${input.scopes.join("` `")}\``, "");
  lines.push(
    "`scope` must be exactly one of those; anything else is rejected and the whole",
    "proposal is thrown away.",
    "",
  );

  lines.push("## The documents", "");
  if (plan.truncated.length > 0) {
    lines.push(
      `The ${String(inventory.bytes)} bytes of seed do not fit in this prompt's `
      + `${String(plan.budgetBytes)}-byte budget. What you are seeing:`,
      "",
    );
    for (const note of plan.truncated) lines.push(`- ${note}`);
    lines.push(
      "",
      "Every other document below is complete. Do not treat a truncated document as",
      "read: judge it by its headings and say so in `why` if you had to.",
      "",
    );
  }
  for (const document of plan.documents) {
    const heading = document.whole
      ? `### \`${document.rel}\` (${String(document.bytes)} bytes, complete)`
      : `### \`${document.rel}\` (${String(document.inlinedBytes)} of ${String(document.bytes)} bytes — TRUNCATED)`;
    lines.push(heading, "");
    if (!document.whole) {
      lines.push("Every heading in the whole document:", "");
      lines.push(document.headings.length === 0 ? "- (none)" : document.headings.join("\n"), "");
      lines.push(document.inlinedBytes === 0 ? "No body text was inlined." : "The first bytes of it:", "");
    }
    if (document.inlinedBytes > 0) {
      const fence = fenceFor(document.text);
      lines.push(fence, document.text, fence, "");
    }
  }

  lines.push(
    "## Produce",
    "",
    "One JSON object, exactly this shape:",
    "",
    "```json",
    "{",
    '  "shared_context": ["<rel path>"],',
    '  "exclude": [{"path": "<rel path>", "reason": "<why this is not worth paying for>"}],',
    '  "runs": [{',
    '    "slug": "<lower-case-hyphenated>", "scope": "<one of the scopes above>",',
    '    "goal": "<one sentence: what this run ships>",',
    '    "seeds": ["<rel path>"], "depends_on": ["<slug>"],',
    `    "size": "${SPLIT_SIZES.join('" | "')}", "budget_usd": <number>,`,
    '    "why": [{"claim": "<what makes this a separate run>", "src": "seed:<rel>#<heading>"}]',
    "  }],",
    '  "questions": [{"id": "Q1", "text": "<what a human must settle>", "options": ["a", "b"]}]',
    "}",
    "```",
    "",
    "## Rules you do not get to bend",
    "",
    "- Every `seeds` and `shared_context` and `exclude[].path` entry is a rel path",
    "  from the inventory table above, spelled exactly. A path that is not there is",
    "  rejected and the whole proposal is thrown away.",
    "- Every `src` is `seed:<rel>#<heading>` or `seed:<rel>:<line>` and names a",
    "  document from the inventory. Nothing else is a legal src here.",
    "- `slug` matches `^[a-z0-9][a-z0-9-]{0,39}$` and is unique in the proposal.",
    "- `depends_on` names other slugs in this same proposal, and the graph has no cycle.",
    "- Every document is accounted for: it is in some run's `seeds`, or in",
    "  `shared_context`, or in `exclude` with a reason. Silently dropping one is the",
    "  failure this whole command exists to prevent.",
    "- Do not invent work the documents do not ask for, and do not merge everything",
    `  into one run — the seed is ${formatTokens(inventory.tokens)} tokens and that is the problem.`,
    `- \`budget_usd\` is a guess at what the run will cost. S ≈ $10, M ≈ $25, L ≈ $50.`,
    "",
    "## Stop",
    "",
  );
  if (input.proposalPath === undefined) {
    lines.push(
      "Return the JSON object as your structured output. Write no files, create no",
      `runs, and run no commands. Your ceiling for this task is $${input.budgetUsd.toFixed(2)}.`,
      "",
    );
  } else {
    lines.push(
      `Write that JSON object — and nothing else — to \`${input.proposalPath}\`, then`,
      "stop. Create no runs and run no commands. `tldrx seed triage --commit` reads",
      "the file back, validates it, and writes `split.yml` itself.",
      "",
    );
  }
  return lines.join("\n");
}

/**
 * A fence longer than the longest backtick run in the body, so a document that
 * contains its own fenced code blocks cannot end the block early. Escaping the
 * body would change bytes the model is being asked to read.
 */
function fenceFor(text: string): string {
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(longest + 1);
}

function headingLines(text: string): readonly string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    if (/^#{1,3}\s+\S/.test(line)) found.push(`- ${line.trim()}`);
  }
  return found;
}
