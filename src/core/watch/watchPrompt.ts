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
import type { PromptInput } from "../facilitator/prompt.ts";
import { MAX_STAGE_INPUTS } from "../run/workflowPreset.ts";
import { renderDiffs, type RepoDiff } from "./epicDiff.ts";
import { EPICS_DIR } from "../plan/validatePlan.ts";
import { PLAN_PHASE, type Feature } from "./features.ts";
import { WATCHERS_DIR, WATCH_PHASE, WATCHER_SECTIONS } from "./Watcher.ts";

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
    "- **Signal** names the log line, metric or event that is IN the diff above, at the line it is on.",
    "  If nothing is emitted, say so with an `absent:` source and say what to instrument. Do not",
    "  describe a signal that would be nice to have as though it exists.",
    "- **Query** is one fenced block, copy-pasteable in whatever place **Where** names.",
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
