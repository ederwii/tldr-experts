/**
 * The prompt one feature's sub-agent gets — and nothing else.
 *
 * Spec §2.3: the declared inputs are "the ONLY files the sub-agent gets", and
 * `prompt.ts` makes that true by inlining their content. Watch keeps the same
 * promise on a per-feature basis: the done stories of ONE epic, that epic's file,
 * the diff of its branch, the observability/deploy facts, and the gotchas of the
 * repos it touched. No repo browsing, no "go look at the logging config" — if a
 * signal is not visible in what is inlined, the honest answer is `absent:` and a
 * `draft` card, which is exactly the outcome this stage exists to produce.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { isLive, type Fact } from "../facts/Fact.ts";
import {
  fenceFor, MAX_PREVIOUS_ATTEMPT_BYTES, PREVIOUS_ATTEMPT_EDIT_HEADING, type PromptInput,
} from "../facilitator/prompt.ts";
import type { SrcContext } from "../text/srcToken.ts";
import { MAX_STAGE_INPUTS } from "../run/workflowPreset.ts";
import { renderDiffs, type RepoDiff } from "./epicDiff.ts";
import { EPICS_DIR } from "../plan/validatePlan.ts";
import { PLAN_PHASE, type Feature } from "./features.ts";
import { WATCHERS_DIR, WATCH_PHASE, WATCHER_SECTIONS } from "./Watcher.ts";
import { describeWatcherIssue, NON_FILE_SOURCE_CURE, parseWatcherCard } from "./watcherFile.ts";

/**
 * The `area:` values (§2.5) a Watch prompt draws facts from. A fact outside them is
 * noise here: this stage is not deciding architecture, it is finding a signal.
 *
 * `ownership` joins the two for gh #70. The card may now name WHO owns a signal,
 * and the only ledger in this framework that names owners is the one it deferred
 * to a person: `tldrx init` parks "Who owns `<repo>`?" as an `ownership` question
 * (`init/questions.ts:152`) and the answer lands in `.tldrx/memory/facts.yml`. A
 * stage asked for an owner with no ownership fact inlined has no honest source
 * for one, and an agent with no source invents — so the area is inlined, and the
 * brief below says the name may come from nowhere else.
 *
 * `[assumption]` — the wave brief names the first two areas; nothing in the
 * workspace enforces an area vocabulary, so a team that tags its facts `ops`
 * instead will see none of them, and the prompt says `absent:` rather than
 * pretending. A workspace with no ownership fact simply writes no `owner:`, and
 * `watch check` falls back to the repo exactly as it did before #70.
 */
export const WATCH_FACT_AREAS = ["observability", "deploy", "ownership"] as const;

export interface FeatureInputsOptions {
  readonly root: string;
  readonly runDir: string;
  readonly feature: Feature;
  readonly diffs: readonly RepoDiff[];
  readonly facts: readonly Fact[];
}

/** Everything the feature's sub-agent may read, already read. */
export function featureInputs(options: FeatureInputsOptions): readonly PromptInput[] {
  const inputs: PromptInput[] = [];

  for (const story of options.feature.stories) {
    inputs.push({ path: story.path, content: story.text });
  }
  const epicPath = `${PLAN_PHASE}/${EPICS_DIR}/${options.feature.epicId}.md`;
  const epicAbs = join(options.runDir, epicPath);
  if (existsSync(epicAbs)) inputs.push({ path: epicPath, content: readFileSync(epicAbs, "utf8") });

  inputs.push({ path: `(git) ${options.feature.epicId} branch vs default branch`, content: renderDiffs(options.diffs) });
  inputs.push({ path: `(facts) area: ${WATCH_FACT_AREAS.join(", ")}`, content: renderWatchFacts(options.facts, options.feature.repos) });

  for (const repo of options.feature.repos) {
    const rel = `${PROJECT_FRAMEWORK_DIR}/map/${repo}/gotchas.md`;
    const abs = join(options.root, rel);
    if (existsSync(abs)) inputs.push({ path: rel, content: readFileSync(abs, "utf8") });
  }
  // Spec §2.3 caps a stage at 20 inputs, and it is counted where they are INLINED
  // as well as where they are declared: a feature spanning many repos must not
  // quietly turn into a prompt of thirty documents.
  return inputs.slice(0, MAX_STAGE_INPUTS);
}

/**
 * `{{facts}}` for this stage, narrowed to the two areas that can carry a signal.
 * A fact scoped to no repo is workspace-wide and always applies (same rule as
 * `prompt.ts`); a retired or superseded one never does.
 */
export function renderWatchFacts(facts: readonly Fact[], repos: readonly string[]): string {
  const areas = new Set<string>(WATCH_FACT_AREAS);
  const relevant = facts.filter(
    (fact) => isLive(fact)
      && areas.has(fact.area)
      && (fact.repos.length === 0 || fact.repos.some((r) => repos.includes(r))),
  );
  if (relevant.length === 0) {
    return `_No live fact is tagged ${WATCH_FACT_AREAS.join(" or ")} for these repos. `
      + "Cite `absent:.tldrx/memory/facts.yml` rather than inventing where a signal is read._";
  }
  return relevant.map((fact) => `- [${fact.id}] ${fact.fact} (${fact.area} · ${fact.confidence})`).join("\n");
}

/** The card's path inside the run — the one file this sub-agent may write. */
export function watcherRelPath(featureId: string): string {
  return `${WATCH_PHASE}/${WATCHERS_DIR}/${featureId}.md`;
}

/**
 * The `## Feature` section spliced into `stage.md`: which card, what front matter
 * it must carry, and the rule that decides its status. The status is stated as
 * something the framework computes, not something the agent chooses — an agent
 * told it may grade itself will.
 */
export function featureBrief(feature: Feature): string {
  const path = watcherRelPath(feature.id);
  const stories = feature.stories.map((s) => s.story.id);
  return [
    `Write exactly ONE file: \`${path}\`. Do not write, edit or delete anything else.`,
    "",
    "Its YAML front matter is fixed — copy it verbatim:",
    "",
    "```yaml",
    "---",
    "version: 1",
    `id: ${feature.id}`,
    `epic: ${feature.epicId}`,
    `title: ${JSON.stringify(feature.title)}`,
    `stories: [${stories.join(", ")}]`,
    `repos: [${feature.repos.join(", ")}]`,
    "status: draft",
    "---",
    "```",
    "",
    `Then these H2 sections, in this order: ${WATCHER_SECTIONS.map((s) => `\`## ${s}\``).join(" · ")}.`,
    "",
    "- Every list item under **Signal**, **Where**, **Healthy baseline** and **Looks broken when**",
    "  ends with a `[src: …]` token: `<repo>:<path>:<line>` for a line in the built code, `F<n>` for",
    "  a recorded fact, or `absent:<what you looked at>` when the code emits nothing.",
    // gh #301: the one case both field runs got wrong — a place that is not a line
    // of code — with the same sentence the validator's refusal carries, and ONE
    // worked example whose token is a real `file` source.
    `- **Where** names a PLACE, and a place is cited like a line: ${NON_FILE_SOURCE_CURE}.`,
    "  An item with no token at all is refused, however obvious the place. One example, for a table",
    "  that no fact and no dashboard names yet:",
    "",
    "      - PostgreSQL `leaderboard_refreshes` table, read with `psql` [src: api:db/migrations/0007_leaderboard_refreshes.sql:1]",
    "",
    "- **Signal** names the log line, metric or event that is IN the diff above, at the line it is on.",
    "  If nothing is emitted, say so with an `absent:` source and say what to instrument. Do not",
    "  describe a signal that would be nice to have as though it exists.",
    "- **Query** is one fenced block, copy-pasteable in whatever place **Where** names.",
    "  If — and ONLY if — the code emits nothing at all, so there is no place to paste a query into,",
    "  write ONE line instead of the block, sourced like every other claim on the card:",
    "",
    "      Query: none — <why nothing is queryable> [src: absent:<what you looked at>]",
    "",
    "  This is CHECKED, not trusted: it is refused unless **Signal** above cites `absent:` and the",
    "  reason's own source is `absent:` too. A card that names a real signal has somewhere to point a",
    "  query at, so `none` on one is a shortcut and will fail the stage. An unsourced `none` is refused",
    "  exactly like an unsourced bullet, and describing a query in prose is still refused either way.",
    "- **Sources** is prose: each citation above, once, with what it establishes.",
    "",
    "Owner (optional, gh #70). A Signal item may name WHO to ask about it, as `(owner: <name>)`",
    "placed BEFORE its `[src: …]` token — the token is still the last thing on the line:",
    "",
    "    - `checkout.completed` is written on every order (owner: alice) [src: api:src/Checkout.cs:88]",
    "",
    "Write it ONLY from an `ownership` fact inlined above, and write the SAME name that fact uses.",
    "Put it in the front matter as `owner: <name>` when one name covers every item on the card, or on",
    "the individual items when they differ. Do not invent a name, do not put a repo name there (the",
    "framework already derives that from your citation), and leave it off entirely when no fact says.",
    "An `(owner: )` with nothing in it is refused — it loses the name it was trying to write.",
    "",
    "Leave `status: draft`. The framework sets it: a card is stamped `verified` only when nothing",
    "under **Signal** cites `absent:`. Writing `verified` yourself changes nothing and will be overwritten.",
  ].join("\n");
}

export interface PreviousCardOptions {
  readonly runDir: string;
  readonly feature: Feature;
  /** The SAME context the executor validates with — a citation resolves here iff it resolves there. */
  readonly ctx: SrcContext;
  readonly maxBytes?: number;
}

/**
 * `## Previous attempt` for ONE feature's retry (gh #301): the card the last
 * attempt left on disk, re-read by the parser that refused it, its refused lines
 * quoted with their line numbers and the validator's own sentence, then the whole
 * card under an instruction to EDIT it.
 *
 * Measured before this existed: a validation failure fails the stage, the retry
 * re-runs `tldrx next` from scratch, and `featurePrompt` was assembled from the
 * same inputs every time — the refusal reached the operator's terminal and never
 * the writer. Attempt 2 on both field runs moved the refusal to a different line,
 * which is what an independent re-generation does; a correction pass needs the
 * draft and the marks. The card is the evidence, not `run.yml`: it is re-validated
 * HERE rather than the recorded error being replayed, so the marks are true of
 * the file as it is now — a card a person has since hand-fixed shows no marks.
 *
 * "" when no card is on disk: a first attempt has no previous attempt, and
 * `buildPrompt` emits no heading for an empty section.
 */
export function previousCard(options: PreviousCardOptions): string {
  const rel = watcherRelPath(options.feature.id);
  const abs = join(options.runDir, rel);
  if (!existsSync(abs)) return "";
  const text = readFileSync(abs, "utf8");
  if (text.trim() === "") return "";

  const card = parseWatcherCard(text, options.ctx, options.feature.id);
  const lines = text.split("\n");
  const out: string[] = [];
  if (card.ok) {
    out.push(
      `The previous attempt at this stage wrote \`${rel}\` and it validates. The stage is being run`,
      "again for another reason; keep this card as it is unless the evidence above contradicts it.",
    );
  } else {
    out.push(
      `The previous attempt at this stage wrote \`${rel}\` and it was REFUSED — `
        + `${String(card.issues.length)} line(s) do not validate. Each one, with the line as written:`,
      "",
    );
    for (const issue of card.issues) {
      out.push(`- ${describeWatcherIssue(issue)}`);
      const quoted = issue.line > 0 ? lines[issue.line - 1] : undefined;
      if (quoted !== undefined && quoted.trim() !== "") out.push(`  > ${quoted}`);
    }
    out.push("", "Fix what is described above. Everything else in this prompt still applies.");
  }

  out.push(
    "",
    `### ${PREVIOUS_ATTEMPT_EDIT_HEADING}`,
    "",
    "This card is on disk RIGHT NOW, exactly as the last attempt left it. It is the draft you are",
    "being paid to fix, not history: keep every item that already carries a `[src: …]` token, cure",
    "the lines marked above, and write the file back at the same path. Starting from a blank page",
    "throws away paid-for work — and, measured, moves a refusal to a different line instead of",
    "curing it.",
    "",
  );
  const budget = options.maxBytes ?? MAX_PREVIOUS_ATTEMPT_BYTES;
  const size = Buffer.byteLength(text, "utf8");
  if (size > budget) {
    out.push(
      `_Not inlined (past the ${budget.toLocaleString("en-US")}-byte previous-attempt budget): `
        + `${rel} (${size.toLocaleString("en-US")} B). It is on disk; read it before you rewrite it._`,
    );
  } else {
    const fence = fenceFor(text);
    out.push(`#### \`${rel}\``, "", fence, text.replace(/\n$/, ""), fence);
  }
  return out.join("\n");
}
