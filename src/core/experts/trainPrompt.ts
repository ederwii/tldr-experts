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
    "## What to write",
    "",
    `- \`${knowledgePath}\` — one H2 per finding, every bullet ending in a \`[src: …]\` token (spec §2.8).`,
    `- Add one \`evidence\` entry per finding to \`.tldrx/experts/${expert.name}/competencies.yml\` `
      + `under area \`${area.id}\`: \`{kind, src, at}\`. Do NOT write \`level\` — it is computed (spec §2.6).`,
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
  ];
  if (mode === "light") return light;
  return [
    ...light,
    `4. Mine past runs under \`tldrx-work/\` for decisions about \`${area}\` that recurred.`,
    "5. Propose the recurring ones as practices; they stay proposals until a human accepts them.",
  ];
}
