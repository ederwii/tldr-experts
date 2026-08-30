/**
 * The prompt one training sub-agent gets — and nothing else.
 *
 * Same promise as every other prompt in this framework (spec §2.3): the declared
 * inputs are inlined, so "read only what is above" is a statement about what is
 * physically in the document rather than a request. Here it matters more than
 * usual, because the output of this prompt becomes EVIDENCE: a sub-agent free to
 * wander the repo could cite a file the pre-pass never scored, and the level it
 * moved would rest on a selection nobody can reproduce.
 *
 * Files are inlined with a line-number gutter. `resolveSrc` only checks that a
 * cited line exists in the file, so a gutter is the difference between a citation
 * that points at the invariant and one that merely lands inside the right file.
 */
import { fenceFor, loadExpertBodies, renderConventions, stackExpertNames } from "../facilitator/prompt.ts";
import { loadExpertKnowledge } from "../experts/expertKnowledge.ts";
import { loadExpert } from "../experts/loadExperts.ts";
import { section, type ExpertDocument } from "../experts/expertDocument.ts";
import { evidenceNote, stars } from "../experts/starChart.ts";
import type { AreaRecord, ExpertRecord } from "../experts/ExpertRecord.ts";
import type { Fact } from "../facts/Fact.ts";
import { FROM_RUNS_SECTIONS, KNOWLEDGE_SECTIONS } from "./knowledgeFile.ts";
import { fromRunsRelPath, knowledgeRelPath, partialOf, type TrainingMode } from "./Training.ts";
import type { FileSelection, InlinedFile } from "./selectFiles.ts";
import type { MinedFile, RunMine } from "./mineRuns.ts";

export interface TrainingPromptInput {
  readonly root: string;
  readonly expert: ExpertRecord;
  readonly document: ExpertDocument;
  readonly area: AreaRecord;
  readonly mode: TrainingMode;
  readonly repos: readonly string[];
  /**
   * Every command `.tldrx/workspace.yml` declares, verbatim — the SAME list that
   * becomes the sub-agent's `Bash(<command>)` grants (`spawnAgent.allowedTools`).
   * The prompt and the tool allowance must be spelled from one list, or the
   * prompt is describing a permission the process does not actually hold.
   */
  readonly commands: readonly string[];
  readonly budgetUsd: number;
}

/** The light-mode prompt: read the selected code, write one knowledge file. */
export function codePrompt(input: TrainingPromptInput, selection: FileSelection): string {
  const rel = partialOf(knowledgeRelPath(input.area.id));
  const target = `.tldrx/experts/${input.expert.name}/${rel}`;

  return [
    ...header(input, "targeted reverse-engineering"),
    "",
    "## What to produce",
    "",
    `Write exactly ONE file: \`${target}\`. Do not write, edit or delete anything else.`,
    "",
    `These H2 sections, in this order: ${KNOWLEDGE_SECTIONS.map((s) => `\`## ${s}\``).join(" · ")}.`,
    "",
    "- **Invariants** — what must always be true here, and the line that makes it true.",
    "- **Entry points** — where control enters this area from outside it.",
    "- **Business rules** — the decisions the code makes, in the terms the business uses.",
    "- **Gotchas** — what would mislead the next reader, and the line that proves it.",
    "- **Sources** — prose. One line per citation above, saying what it establishes. It is a recap:",
    "  it earns no evidence and no level, so do not pad it and do not put a finding there.",
    "",
    ...FINDING_CRITERION,
    "",
    `Every list item in the file ends with a \`[src: …]\` token. The four claim sections must`,
    "each hold at least one item. The token forms you may use here:",
    "",
    "- `[src: <repo>:<path>:<line>]` — a line in one of the files inlined below. Use the",
    "  gutter numbers; a citation whose line is outside the file is rejected.",
    "- `[src: absent:<what you looked at>]` — you looked and there is nothing. This is a real",
    "  finding and it is how a section with nothing in it is written. It earns no evidence.",
    "- `[src: F<n>]` — a fact already on record. `[src: https://…]` — a doc you fetched fresh.",
    "",
    "**End every bullet with `(measured)`, `(inferred)` or `(assumed)` before its `[src: …]` token.**",
    "`(measured)` = you read the literal line or ran the command; `(inferred)` = a mechanism plus",
    "evidence, and you name the mechanism; `(assumed)` = you have not checked, and the framework",
    "halves what the row is worth. The annotation is parsed, recorded on the evidence row and",
    "weighed (§2.6); a bullet with none is read as unlabelled, not as measured.",
    "",
    "**The file is validated off disk and accepted or rejected whole.** One unsourced item,",
    "one line number outside its file, and nothing is kept: no knowledge file, no evidence, no",
    "level change. Write fewer claims rather than softer sources.",
    "",
    "**A claim about a RESULT needs a command, not a file line.** \"exit 0\", \"78/78 passed\",",
    "\"the build is green\", or the word \"measured\" used in the sentence itself — any of those in a",
    "bullet or a paragraph must carry a `` [src: $ <cmd> → exit <n>] `` src. Citing the line of",
    "`workspace.yml` that DECLARES the command is not evidence that it ran, and the file is",
    "refused for it.",
    "",
    "## How this becomes a level",
    "",
    `Each DISTINCT file you cite becomes one \`{kind: code, src, at}\` row under area`,
    `\`${input.area.id}\` in \`competencies.yml\`, and the level is recomputed from those rows by`,
    "the spec §2.6 formula. You do not write the level and you do not write the evidence — the",
    "framework derives both from what you cited.",
    "",
    "**A bullet citing two or more DISTINCT files counts double** (§2.6 `cross`), because that is",
    "the finding a reader cannot re-derive from any one file. A bullet the framework judges a",
    "paraphrase of the line it cites counts nothing, and so does a citation outside this expert's",
    "`## Domain` or one it already has on record from another area. Breadth of files is not the",
    "target and never was: twelve shallow bullets over twelve files is worth less here than three",
    "that tie files together, and it is the shape this prompt used to ask for by mistake.",
    "",
    ...ceiling(input),
    "",
    "## Selection",
    "",
    `The files below were chosen deterministically — keywords \`${selection.keywords.join("`, `")}\``,
    `over ${describeRepos(selection.repos)}, ranked by the map, the graph and a grep.`,
    `${String(selection.scanned)} code file(s) were scored${selection.scanTruncated ? " (the walk hit its cap, so the scan is partial)" : ""}.`,
    "",
    ...domainBoundaryNote(selection),
    ...notReadNote(selection),
    ...graphNote(selection),
    ...domainNote(selection),
    "",
    "## Inputs",
    "",
    renderInlined(selection.inlined),
    "",
    ...rules(input),
    "",
    "## Stop",
    "",
    "Stop when every item has a source. An unsourced finding is not evidence, and adding it",
    "would raise a level that nothing supports.",
    "",
    ...expertBodies(input),
  ].join("\n");
}

/** The full-mode second prompt: distil what past runs keep deciding. */
export function runsPrompt(input: TrainingPromptInput, mine: RunMine): string {
  const rel = partialOf(fromRunsRelPath(input.area.id));
  const target = `.tldrx/experts/${input.expert.name}/${rel}`;

  return [
    ...header(input, "mining past runs"),
    "",
    "## What to produce",
    "",
    `Write exactly ONE file: \`${target}\`. Do not write, edit or delete anything else.`,
    "",
    `These H2 sections, in this order: ${FROM_RUNS_SECTIONS.map((s) => `\`## ${s}\``).join(" · ")}.`,
    "",
    "- **Recurring decisions** — a decision this team has now made more than once. Name it as a",
    "  standing rule, not as a story.",
    "- **Recurring patterns** — a shape that keeps appearing in how the work is done.",
    "- **Sources** — prose. One line per citation, saying what it establishes.",
    "",
    "A decision that appears **once** is not recurring. Say so with",
    "`- none [src: absent:tldrx-work]` rather than promoting a single occurrence: the whole",
    "value of this file is that it distinguishes a habit from an incident.",
    "",
    "Every list item ends with a `[src: …]` token, and only two forms count as evidence here:",
    "",
    "- `[src: tldrx-work/<run>/<file>:<line>]` — a line in one of the documents below.",
    "- `[src: F<n>]` — a fact already on record.",
    "",
    "`[src: absent:<what you looked at>]` is legal and earns no evidence.",
    "",
    "**Out of scope, deliberately:** Claude Code transcripts. They carry no citation a reader",
    "can re-resolve, so nothing mined from one may enter this file.",
    "",
    "## Selection",
    "",
    ...mine.notes.map((note) => `- ${note}`),
    ...(mine.notRead.length === 0 ? [] : [
      "",
      `**Not read** (past the ${String(mine.files.length)}-file / 64 KB cap) — do not guess at their content:`,
      ...mine.notRead.map((path) => `- \`${path}\``),
    ]),
    "",
    "## Inputs",
    "",
    renderMined(mine.files),
    "",
    "### Facts on record",
    "",
    renderFactRows(mine.facts),
    "",
    ...rules(input),
    "",
    "## Stop",
    "",
    "Stop when every item has a source and every item names something that happened more than",
    "once.",
    "",
    ...expertBodies(input),
  ].join("\n");
}

// --- shared pieces ----------------------------------------------------------

function header(input: TrainingPromptInput, what: string): readonly string[] {
  const role = section(input.document.body, "Role");
  return [
    `# Train \`${input.expert.name}\` — area \`${input.area.id}\` (${input.mode} mode: ${what})`,
    "",
    `Expert: ${input.expert.name} · status ${input.expert.status} · last trained ${input.expert.lastTrained ?? "never"}`,
    `Area: ${input.area.id} — ${input.area.title}`,
    `Level now: ${stars(input.area.level)} ${String(input.area.level)}/5 ${evidenceNote(input.area)}`,
    `Ceiling for this sub-agent: $${input.budgetUsd.toFixed(2)}`,
    "",
    "## Role",
    "",
    role === "" ? `Speak for the \`${input.area.id}\` area of this workspace.` : role,
  ];
}

function rules(input: TrainingPromptInput): readonly string[] {
  const cite = section(input.document.body, "What to cite");
  return [
    "## Rules",
    "",
    ...(cite === "" ? [] : [cite, ""]),
    "- Read only what is inlined above. Nothing else is in scope and nothing else is inlined.",
    "- Never cite a variable name, a docstring or a UI label as evidence of behaviour.",
    "- Say which of *measured* / *inferred* / *assumed* each claim is.",
    "- Do not modify product code, and do not install anything.",
    ...commandRule(input),
    "",
    "## Conventions",
    "",
    renderConventions(input.root, input.repos),
  ];
}

/**
 * What this sub-agent may execute, spelled from the same list that becomes its
 * `Bash(<command>)` grants.
 *
 * The prompt used to read "do not run anything" while `allowedTools` already
 * handed the sub-agent a `Bash(<command>)` for every command in `workspace.yml`
 * (`spawnAgent.ts`, `allowedTools`). The instruction and the permission
 * contradicted each other, and the instruction won — so no training run ever
 * executed a command, no run ever produced a `kind: run` row, and light mode was
 * pinned under the §2.6 run cap forever.
 *
 * With no declared command there is no `Bash` grant at all, and saying so is the
 * honest form: the expert cannot earn a `run` row in this workspace, and the
 * ladder will cap it at 3 whatever it reads.
 */
function commandRule(input: TrainingPromptInput): readonly string[] {
  if (input.commands.length === 0) {
    return [
      "- **Do not run anything.** `.tldrx/workspace.yml` declares no command, so you hold no",
      "  `Bash` tool at all. No `run` evidence is reachable in this workspace, and the §2.6 run",
      "  cap therefore holds this area at level 3 however much you read. That is the honest",
      "  ceiling; do not try to work around it.",
    ];
  }
  return [
    "- **You may run ONLY the commands `.tldrx/workspace.yml` declares**, spelled exactly as",
    `  written: ${input.commands.map((command) => `\`${command}\``).join(" · ")}.`,
    "  Nothing else — no installs, no package manager, no ad-hoc shell, no variation on those",
    "  strings. That list is your entire `Bash` allowance, so anything else fails anyway.",
    "- **Cite every command you ran** as `` [src: $ <cmd> → exit <n>] ``, with the command",
    "  spelled as above and the exit code you actually saw (a non-zero exit is evidence too —",
    "  report it, never re-run until it is green). That token is the ONLY way this expert earns",
    "  a `kind: run` row, and a `run` row is what spec §2.6 requires for levels 4 and 5.",
  ];
}

/** The level this run can honestly reach, which depends on whether it may run anything. */
function ceiling(input: TrainingPromptInput): readonly string[] {
  if (input.commands.length === 0) {
    return [
      "**This run cannot go past level 3, and that is correct.** Since 2026-08-29 the ladder caps",
      "any area with no `kind: run` row at 3, and reading — which is all this workspace lets you",
      "do, since `.tldrx/workspace.yml` declares no command — produces `code`, `doc` and `answer`",
      "rows only. Do not pad the file to chase a number; the number is not reachable from here.",
    ];
  }
  return [
    "**Reading alone stops at level 3.** Since 2026-08-29 the ladder caps any area with no",
    "`kind: run` row at 3, and reading produces `code`, `doc` and `answer` rows only. The one way",
    "past that cap from here is to RUN one of the workspace commands listed under **Rules** below",
    "and cite it as `` [src: $ <cmd> → exit <n>] `` — a command that was executed is the",
    "measurement the cap is asking for, and one of them is worth more than fifty more readings.",
    "Do not pad the file to chase a number: an unsourced claim is rejected, and a file you have",
    "already cited is worth nothing the second time.",
  ]
}

/**
 * The expert's own body, plus the stack experts of the repos it speaks for — each
 * carrying whatever earlier training already put on record.
 *
 * A training run that cannot see what the LAST training run found rediscovers it
 * and writes a second copy of the same finding, which is how an area reaches
 * twelve evidence rows over one file (spec §2.6, the distinct-source cap exists
 * for exactly that).
 */
function expertBodies(input: TrainingPromptInput): readonly string[] {
  const names = [input.expert.name, ...stackExpertNames(input.root, input.repos)];
  return loadExpertBodies(input.root, names).map((expert) => {
    const knowledge = loadExpertKnowledge({
      root: input.root,
      name: expert.name,
      record: loadExpert(input.root, expert.name),
    }).text.trim();
    const tail = knowledge === "" ? "" : `\n${knowledge}\n`;
    return `\n---\n\n<!-- expert: ${expert.name} -->\n${expert.body.trimEnd()}\n${tail}`;
  });
}

/**
 * What makes a bullet worth writing — the criterion the old prompt did not have.
 *
 * It used to reward file breadth outright ("reading twelve files is worth
 * twelve"), which is a Goodhart recipe and the audit found the expected result: a
 * third of the corpus was verbatim paraphrase of docstrings, one bullet per file,
 * spread wide. The replacement is a test a writer can apply to their own sentence
 * before writing it, and it is deliberately negative — it says what does NOT count.
 */
const FINDING_CRITERION: readonly string[] = [
  "**What counts as a finding.** A finding is something a model could not re-derive by reading",
  "that one file once. Concretely, these do:",
  "",
  "- a contradiction ACROSS files — a default that differs from the docstring that describes it,",
  "  a caller passing a key the callee never registers, two paths that disagree about an order;",
  "- a dead path — code nothing reaches, a branch no call site can take, a guard with no caller;",
  "- an ABSENCE, written with a negative claim and an `absent:` source — \"there is no",
  "  `UseHttpsRedirection` anywhere in this pipeline\" is a finding; you looked, and it is not there;",
  "- a measured command, cited as `` [src: $ <cmd> → exit <n>] ``.",
  "",
  "These do not: restating a docstring, a comment or a variable name in other words; naming a",
  "file's obvious purpose; \"X is registered in DI\" with no consequence attached. If the sentence",
  "is true of the line and adds nothing to it, the next reader gains nothing from it either — and",
  "the framework will flag it as a paraphrase and derive no evidence from it.",
];

function domainBoundaryNote(selection: FileSelection): readonly string[] {
  if (selection.domainPaths.length === 0) return [];
  return [
    `**Domain boundary** — this expert declares ${selection.domainPaths.map((path) => `\`${path}\``).join(", ")}`,
    "in its `## Domain`, so only files inside it were scored and inlined. A citation outside it",
    "earns this expert no evidence (it belongs to whichever expert owns that folder), so do not",
    "reach for one.",
    "",
  ];
}

function describeRepos(repos: readonly string[]): string {
  return repos.length === 0 ? "no declared repo" : repos.map((repo) => `\`${repo}\``).join(", ");
}

function notReadNote(selection: FileSelection): readonly string[] {
  if (selection.notRead.length === 0) return [];
  return [
    `**Not read** — ${String(selection.notRead.length)} further file(s) ranked below the cap. They exist; do not`,
    "guess at their content, and cite `absent:` rather than describing them:",
    "",
    ...selection.notRead.slice(0, 60).map((file) => `- \`${file.repo}:${file.path}\``),
    ...(selection.notRead.length > 60 ? [`- (+${String(selection.notRead.length - 60)} more)`] : []),
    "",
  ];
}

function graphNote(selection: FileSelection): readonly string[] {
  if (selection.graphNotes.length === 0) return [];
  return ["**Graph:**", "", ...selection.graphNotes.map((note) => `- ${note}`), ""];
}

function domainNote(selection: FileSelection): readonly string[] {
  if (selection.domainLines.length === 0) return [];
  return [
    "**What `tldrx map` already recorded as domains** (its citations resolve; reuse them):",
    "",
    ...selection.domainLines.slice(0, 40).map((line) => `- ${line}`),
    "",
  ];
}

export function renderInlined(files: readonly InlinedFile[]): string {
  if (files.length === 0) {
    return "_No file scored above zero for this area. Say so with an `absent:` source rather than\n"
      + "writing what you expect a codebase like this to contain._";
  }
  const out: string[] = [
    "These files are the ONLY ones you may read. Their content is inlined below with a",
    "line-number gutter — cite those numbers.",
    "",
  ];
  for (const file of files) {
    const numbered = withGutter(file.content);
    const fence = fenceFor(numbered);
    out.push(
      `### \`${file.repo}:${file.path}\``,
      "",
      `_score ${String(file.score)} — ${file.why.join("; ")}. ${String(file.lines)} line(s), ${String(file.bytes)} bytes`
        + `${file.truncated ? "; **truncated** — the tail is not inlined, so do not cite past the last gutter number" : ""}._`,
      "",
      fence,
      numbered,
      fence,
      "",
    );
  }
  return out.join("\n");
}

export function renderMined(files: readonly MinedFile[]): string {
  if (files.length === 0) {
    return "_No past run matched this expert's repos. There is nothing to mine, and the honest\n"
      + "output is `- none [src: absent:tldrx-work]` in each section._";
  }
  const out: string[] = [
    "These documents are the ONLY ones you may read. Cite them as",
    "`tldrx-work/<run>/<file>:<line>`, using the gutter numbers below.",
    "",
  ];
  for (const file of files) {
    const numbered = withGutter(file.content);
    const fence = fenceFor(numbered);
    out.push(
      `### \`${file.path}\``,
      "",
      `_run ${file.run}, ${String(file.lines)} line(s)${file.truncated ? "; **truncated**" : ""}._`,
      "",
      fence,
      numbered,
      fence,
      "",
    );
  }
  return out.join("\n");
}

export function renderFactRows(facts: readonly Fact[]): string {
  if (facts.length === 0) {
    return "_No non-retired fact matches this area or these repos. Cite `absent:.tldrx/memory/facts.yml`\n"
      + "rather than inventing what the team decided._";
  }
  return facts.map((fact) => `- [${fact.id}] ${fact.fact} (${fact.area} · ${fact.confidence})`).join("\n");
}

/** `   1| line` — right-aligned to the width of the last line number. */
export function withGutter(content: string): string {
  const lines = content.split("\n");
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)}| ${line}`).join("\n");
}
