/**
 * The copy-paste training prompt (`tldrx expert train … --print-prompt`).
 *
 * v0 prints; it does not spawn. Training itself is v1.1 (concept §6), so the
 * honest v0 deliverable is the exact text a human can paste into a session — and
 * because it is assembled from files alone (expert.md, competencies.yml,
 * workspace.yml), the same inputs always produce the same prompt.
 *
 * Light  = targeted reverse-engineering of this area, `file:line` provenance.
 * Full   = light, plus mining past runs for recurring decisions worth promoting
 *          to practices (concept §6).
 *
 * `[assumption]` `--mode` defaults to `light`, the cheaper of the two, and the
 * prompt body for each mode is written here rather than read from a template —
 * there is no training template in `templates/` to read.
 */
import { evidenceNote, stars } from "./starChart.ts";
import { EVIDENCE_KINDS, EVIDENCE_KIND_MEANINGS } from "../init/competencyLevel.ts";
import { section } from "./expertDocument.ts";
import type { AreaRecord, ExpertRecord } from "./ExpertRecord.ts";
import type { ExpertDocument } from "./expertDocument.ts";

export const TRAIN_MODES = ["light", "full"] as const;
export type TrainMode = (typeof TRAIN_MODES)[number];

export interface TrainRepo {
  readonly name: string;
  readonly path: string;
}

export interface TrainPromptInput {
  readonly expert: ExpertRecord;
  readonly document: ExpertDocument;
  readonly area: AreaRecord;
  readonly mode: TrainMode;
  readonly repos: readonly TrainRepo[];
}

export function isTrainMode(value: string): value is TrainMode {
  return (TRAIN_MODES as readonly string[]).includes(value);
}

export function renderTrainPrompt(input: TrainPromptInput): string {
  const { expert, area, mode, repos, document } = input;
  const role = section(document.body, "Role");
  const cite = section(document.body, "What to cite");
  const knowledgePath = `.tldrx/experts/${expert.name}/knowledge/${area.id}.md`;

  const lines: string[] = [
    `# Train \`${expert.name}\` — area \`${area.id}\` (${mode} mode)`,
    "",
    `Expert: ${expert.name} · status ${expert.status} · last trained ${expert.lastTrained ?? "never"}`,
    `Area: ${area.id} — ${area.title}`,
    `Level now: ${stars(area.level)} ${area.level}/5 ${evidenceNote(area)}`,
    "",
    "## Role",
    "",
    role === "" ? `Speak for the \`${area.id}\` area of this workspace.` : role,
    "",
    "## Repos in this workspace",
    "",
    ...(repos.length === 0
      ? ["- none declared in `.tldrx/workspace.yml` — run `tldrx init` first"]
      : repos.map((repo) => `- \`${repo.name}\` at \`${repo.path}\``)),
    "",
    "## What to do",
    "",
    ...steps(mode, area.id),
    "",
    "## What counts as a finding",
    "",
    ...FINDING_CRITERION,
    "",
    "## What to write",
    "",
    `- \`${knowledgePath}\` — one H2 per finding, every bullet ending in a \`[src: …]\` token (spec §2.8).`,
    "- End each bullet with `(measured)`, `(inferred)` or `(assumed)` BEFORE its `[src: …]` token.",
    "  It is parsed onto the evidence row as `confidence:`; `assumed` is weighed at half (spec §2.6).",
    "- A bullet citing two or more DISTINCT files is worth double (`cross: true`, spec §2.6) —",
    "  a cross-file finding is the one a reader cannot re-derive from any single file.",
    // Stated with both lines side by side since 2026-08-30: a real run was refused
    // for exactly this and the one-line form had not told its writer what a
    // conforming citation looks like. `training/trainingPrompt.ts` teaches the
    // same rule at length to the SPAWNED sub-agent; keep the two saying one thing.
    "- A claim about a RESULT — \"exit 0\", \"78/78 passed\", \"the build is green\", or the bare word",
    "  \"measured\" standing in the sentence itself — must carry a `` [src: $ <cmd> → exit <n>] `` src,",
    "  and the file is refused WHOLE for one that does not. Write",
    "  `` - The suite covers the empty-input branch (measured) [src: $ npm test → exit 0] ``; never",
    "  `` - npm test exits 0 here [src: api:.tldrx/workspace.yml:19] ``, because line 19 DECLARES the",
    "  command and is not a record of running it. Not running it is the other legal answer: say what",
    "  the CODE does instead, and the claim needs no command. The trailing `(measured)` annotation is",
    "  stripped before the check and can never trip this.",
    `- Add one \`evidence\` entry per finding to \`.tldrx/experts/${expert.name}/competencies.yml\` `
      + `under area \`${area.id}\`: \`{kind, src, at}\`. Do NOT write \`level\` — it is computed (spec §2.6).`,
    "- `kind` is one of these five. Anything else is dropped when the file is read,",
    "  and the level drops with it:",
    ...EVIDENCE_KINDS.map((kind) => `  - \`${kind}\` — ${EVIDENCE_KIND_MEANINGS[kind]}`),
    "- Stars: without a `run` row the level caps at 3; level 5 needs two kinds and 20 weighted.",
    "  Record every command you actually execute as `{kind: run, src: \"$ <cmd> → exit <n>\", at: …}`"
      + " — build, tests, a script; one row per command, exit code included.",
    `- When the evidence is written, run \`tldrx expert recompute ${expert.name}\`. \`level\` only moves`,
    "  when something writes it, and this session is not that something — without it the file",
    "  keeps the old number and every reader warns about the disagreement.",
    "",
    "## Rules",
    "",
    ...(cite === "" ? DEFAULT_RULES : [cite, "", ...DEFAULT_RULES]),
    "",
    "## Stop",
    "",
    "Stop when every finding has a source token. An unsourced finding is not evidence,",
    "and adding it would raise a level that nothing supports.",
    "",
  ];
  return lines.join("\n");
}

/**
 * The value criterion, shared word-for-word with the spawning prompt
 * (`training/trainingPrompt.ts`). Two prompts asking for two different things is
 * how `--print-prompt` and the headless path end up producing different files.
 */
const FINDING_CRITERION: readonly string[] = [
  "A finding is something a model could not re-derive by reading that one file once:",
  "",
  "- a contradiction ACROSS files — a default that differs from the docstring describing it, a",
  "  caller passing a key the callee never registers, two paths that disagree about an order;",
  "- a dead path — code nothing reaches, a branch no call site can take, a guard with no caller;",
  "- an ABSENCE, written as a negative claim with an `absent:` source;",
  "- a measured command, cited as `$ <cmd> → exit <n>`.",
  "",
  "Restating a docstring, a comment or a variable name in other words is not a finding, however",
  "correct it is: the framework flags it as a paraphrase and derives no evidence from it.",
];

const DEFAULT_RULES: readonly string[] = [
  "- Cite code as `repo:path:line`, docs as an `https://` URL fetched fresh, prior answers as `F<n>`.",
  "- Never cite a variable name, a docstring or a UI label as evidence of behaviour.",
  "- Say which of *measured* / *inferred* / *assumed* each claim is.",
  "- Read only this workspace. Do not install anything and do not modify product code.",
];

function steps(mode: TrainMode, area: string): readonly string[] {
  const light: readonly string[] = [
    `1. Locate every entry point, invariant and business rule for \`${area}\` in the repos above.`,
    "2. Read the code before the docs; read the docs before memory.",
    "3. Record each finding with its `file:line`, and note what you looked for and did NOT find.",
    "4. Prefer a claim that ties two files together to two claims about one file each.",
  ];
  if (mode === "light") return light;
  return [
    ...light,
    `5. Mine past runs under \`tldrx-work/\` for decisions about \`${area}\` that recurred.`,
    "6. Propose the recurring ones as practices; they stay proposals until a human accepts them.",
  ];
}
