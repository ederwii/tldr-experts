/**
 * The context ledger — what the prompt is made of, in bytes, before it is sent.
 *
 * Until wave N there was no total. `pending.json` carried bytes per expert and
 * nothing else, so the only way to learn that a stage prompt was 159,575 bytes —
 * 45% declared inputs, 52% expert knowledge nobody asked for — was to run
 * `--prepare` and `wc -c` the file. A budget you can only measure after you have
 * spent it is a report, not a budget.
 *
 * Two rules come out of the ledger:
 *
 *  - **`prompt_max_bytes` is a refusal.** Over it, `next` exits 2 BEFORE a
 *    sub-agent is spawned, names the biggest sections, and prints the key or the
 *    command that shrinks each one. The §2.11 money gate already works this way
 *    ("refuse to start work it cannot afford"); this is the same sentence about
 *    context instead of dollars.
 *  - **The model's context window is a warning, never a refusal.** Over 80% of it
 *    the operator is told, on stderr, and the stage still runs: the window is
 *    `[assumption]` (`budget/modelPrices.ts`), the byte-to-token ratio is
 *    `[assumption]`, and refusing on two assumptions stacked is how a framework
 *    blocks work it could have done. A hard refusal is reserved for the number a
 *    human actually wrote down.
 */
import { byteLength } from "../experts/expertKnowledge.ts";
import {
  contextTokensFor, estimateTokensFromBytes,
} from "../budget/modelPrices.ts";
import type { PromptPart, PromptPartKind } from "./prompt.ts";
import type { TruncatedInput } from "./seedInputs.ts";

/**
 * `[assumption]` — 160 KB ≈ 44k tokens, which is what the measured aparece What
 * prompt already was. It is deliberately NOT generous: it is set just above the
 * largest prompt this framework has been observed to build, so the first prompt
 * that grows past what has ever been seen stops and says so.
 */
export const DEFAULT_PROMPT_MAX_BYTES = 160 * 1024;

/** Warn at this share of the model's context window. */
export const CONTEXT_WARN_PCT = 80;

export interface LedgerRow {
  readonly kind: PromptPartKind;
  /** `stage.md`, a declared input path, or an expert name. */
  readonly name: string;
  readonly bytes: number;
}

export interface LedgerGroups {
  readonly stage: number;
  readonly inputs: number;
  readonly experts: number;
  readonly expertBodies: number;
  readonly expertKnowledge: number;
  /** The host's own `## Dispatch notes` section — 0 when it left no file. */
  readonly dispatchNotes: number;
  readonly previousAttempt: number;
  /** The `## Questions` section of `stage.md`, counted out of the stage total. */
  readonly questions: number;
}

export interface ContextLedger {
  readonly totalBytes: number;
  readonly rows: readonly LedgerRow[];
  readonly groups: LedgerGroups;
  readonly truncatedInputs: readonly TruncatedInput[];
  /** `prompt_max_bytes` this ledger was measured against. */
  readonly limitBytes: number;
  readonly overLimit: boolean;
  readonly model: string | null;
  readonly estimatedTokens: number;
  readonly contextTokens: number;
  readonly contextPct: number;
  /** True at or over `CONTEXT_WARN_PCT` of the model's window. Never a refusal. */
  readonly contextWarns: boolean;
}

export interface LedgerInput {
  readonly parts: readonly PromptPart[];
  /** Per-file bytes for the `inputs` part, which `renderParts` emits as one blob. */
  readonly inputBytes: readonly { readonly path: string; readonly bytes: number }[];
  readonly truncatedInputs: readonly TruncatedInput[];
  readonly limitBytes: number;
  readonly model: string | null;
  /** Bytes of the rendered `stage.md`'s `## Questions` section, when it has one. */
  readonly questionsBytes?: number;
}

export function buildLedger(input: LedgerInput): ContextLedger {
  const rows: LedgerRow[] = [];
  let stage = 0;
  let inputs = 0;
  let expertBodies = 0;
  let expertKnowledge = 0;
  let dispatchNotes = 0;
  let previousAttempt = 0;

  for (const part of input.parts) {
    const bytes = byteLength(part.text);
    switch (part.kind) {
      case "stage":
        stage += bytes;
        rows.push({ kind: part.kind, name: part.name, bytes });
        break;
      case "expert-body":
        expertBodies += bytes;
        rows.push({ kind: part.kind, name: part.name, bytes });
        break;
      case "expert-knowledge":
        expertKnowledge += bytes;
        rows.push({ kind: part.kind, name: part.name, bytes });
        break;
      case "dispatch-notes":
        // Counted inside `prompt_max_bytes` like everything else: a slot the
        // framework does not read is still a slot the model is billed for.
        dispatchNotes += bytes;
        rows.push({ kind: part.kind, name: part.name, bytes });
        break;
      case "previous-attempt":
        previousAttempt += bytes;
        rows.push({ kind: part.kind, name: part.name, bytes });
        break;
      case "inputs":
        // The `## Inputs` part is one rendered blob; the interesting breakdown is
        // per FILE, which only the caller knows. Its framing prose is the
        // difference between the blob and the sum of the files, and is charged to
        // `inputs` so the group totals still add up to `totalBytes`.
        inputs += bytes;
        for (const file of input.inputBytes) {
          rows.push({ kind: "inputs", name: file.path, bytes: file.bytes });
        }
        break;
    }
  }

  const totalBytes = stage + inputs + expertBodies + expertKnowledge + dispatchNotes + previousAttempt;
  const estimatedTokens = estimateTokensFromBytes(totalBytes);
  const contextTokens = contextTokensFor(input.model);
  const contextPct = contextTokens === 0 ? 0 : (estimatedTokens / contextTokens) * 100;

  return {
    totalBytes,
    rows,
    groups: {
      stage,
      inputs,
      experts: expertBodies + expertKnowledge,
      expertBodies,
      expertKnowledge,
      dispatchNotes,
      previousAttempt,
      questions: input.questionsBytes ?? 0,
    },
    truncatedInputs: input.truncatedInputs,
    limitBytes: input.limitBytes,
    overLimit: totalBytes > input.limitBytes,
    model: input.model,
    estimatedTokens,
    contextTokens,
    contextPct,
    contextWarns: contextPct >= CONTEXT_WARN_PCT,
  };
}

/** The `## Questions` section of a rendered `stage.md`, in bytes. 0 when absent. */
export function questionsBytesOf(stageMd: string): number {
  const lines = stageMd.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Questions");
  if (start === -1) return 0;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if ((lines[i] ?? "").startsWith("## ")) {
      end = i;
      break;
    }
  }
  return byteLength(lines.slice(start, end).join("\n"));
}

/** The ledger as `--prepare`/`--dry-run` prints it: totals, then the big rows. */
export function renderLedger(ledger: ContextLedger, maxRows = 8): readonly string[] {
  const g = ledger.groups;
  const lines = [
    `context ${bytes(ledger.totalBytes)} of ${bytes(ledger.limitBytes)} `
      + `(~${tokens(ledger.estimatedTokens)} tok, ${ledger.contextPct.toFixed(0)}% of `
      + `${shortModel(ledger.model)}'s ~${tokens(ledger.contextTokens)} window)`,
    `  stage ${bytes(g.stage)}${g.questions === 0 ? "" : ` (questions ${bytes(g.questions)})`}`
      + ` · inputs ${bytes(g.inputs)} · experts ${bytes(g.experts)}`
      + ` (bodies ${bytes(g.expertBodies)}, knowledge ${bytes(g.expertKnowledge)})`
      + (g.dispatchNotes === 0 ? "" : ` · dispatch notes ${bytes(g.dispatchNotes)}`)
      + (g.previousAttempt === 0 ? "" : ` · previous attempt ${bytes(g.previousAttempt)}`),
  ];
  const biggest = [...ledger.rows]
    .filter((row) => row.kind !== "inputs" || row.name !== "Inputs")
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, maxRows);
  for (const row of biggest) {
    lines.push(`  ${label(row)} ${bytes(row.bytes)}`);
  }
  return lines;
}

/**
 * The refusal (exit 2). Names the sections that are big, and for each one the KEY
 * or the COMMAND that shrinks it — the same lesson the money gate learned when a
 * pilot's hand-edit of `ceiling_usd` under-shot and the retry was refused twice.
 */
export function renderRefusal(ledger: ContextLedger, stageId: string): readonly string[] {
  const g = ledger.groups;
  const lines = [
    `[tldrx] context: refusing to start stage "${stageId}" — the prompt is `
      + `${bytes(ledger.totalBytes)} and prompt_max_bytes is ${bytes(ledger.limitBytes)}.`,
    ...renderLedger(ledger, 5),
    "Shrink it, then run again:",
  ];
  if (g.inputs >= g.experts) {
    lines.push(
      `  inputs are the biggest section (${bytes(g.inputs)}) — lower \`inputs_max_bytes\` `
      + "in the stage file, declare fewer inputs, or split the seed with `tldrx seed triage`.",
    );
  }
  if (g.experts > 0) {
    lines.push(
      `  experts are ${bytes(g.experts)} (${bytes(g.expertKnowledge)} of it trained knowledge) — `
      + "lower `knowledge_max_bytes` in the stage file, or narrow the stage's `experts:` list.",
    );
  }
  lines.push(
    `  or raise the ceiling deliberately: \`prompt_max_bytes\` in the stage file, `
    + "or `--prompt-max-bytes <n>` for this one invocation.",
  );
  return lines;
}

/** The stderr warning when the prompt is a large share of the model's window. */
export function renderContextWarning(ledger: ContextLedger): readonly string[] {
  if (!ledger.contextWarns) return [];
  return [
    `note: this prompt is ~${tokens(ledger.estimatedTokens)} tokens, `
    + `${ledger.contextPct.toFixed(0)}% of ${shortModel(ledger.model)}'s ~${tokens(ledger.contextTokens)}-token `
    + "window [assumption: both the window and the ~3.6 bytes/token ratio are estimates, "
    + "see src/core/budget/modelPrices.ts]. The sub-agent still has to fit its own reading and "
    + "its answer in what is left.",
  ];
}

function label(row: LedgerRow): string {
  switch (row.kind) {
    case "stage": return "stage.md";
    case "inputs": return `input ${row.name}`;
    case "expert-body": return `expert ${row.name} body`;
    case "expert-knowledge": return `expert ${row.name} knowledge`;
    case "dispatch-notes": return "dispatch notes";
    case "previous-attempt": return "previous attempt";
  }
}

function shortModel(model: string | null): string {
  return model === null || model === "" ? "the default model" : model;
}

export function bytes(count: number): string {
  return count < 1024 ? `${String(count)} B` : `${(count / 1024).toFixed(1)} KB`;
}

function tokens(count: number): string {
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}
