/**
 * `05-watch/handoff.md`, written by the executor rather than by a sub-agent.
 *
 * Every line of it is a restatement of something already on disk: which cards
 * exist, what status each one earned, which done stories each was written from.
 * A model asked to summarise its own cards would be free to describe a `draft`
 * card as coverage, and the handoff is the artefact the next reader trusts most.
 * So the cards are the model's work and this file is arithmetic over them.
 *
 * Spec §2.8 shape: four sections, in order, each holding at least one sourced list
 * item — including the empty case, which says `- none [src: absent:…]`.
 */
import { HANDOFF_SECTIONS } from "../text/handoff.ts";
import { WATCHERS_DIR, WATCH_PHASE } from "./Watcher.ts";
import type { WatcherCard } from "./watcherFile.ts";
import type { Feature } from "./features.ts";
import { PLAN_PHASE } from "./features.ts";

/** What the empty run cites: the Plan folder it looked in and found no done story. */
export const NO_STORIES_SRC = `absent:${PLAN_PHASE}/stories`;

export interface WrittenCard {
  readonly feature: Feature;
  /** Path relative to the run dir. */
  readonly path: string;
  readonly card: WatcherCard;
}

export interface HandoffContext {
  readonly runId: string;
  readonly stageId: string;
  readonly experts: readonly string[];
  readonly model: string | null;
  readonly costUsd: number;
  readonly budgetUsd: number;
  readonly at: string;
}

export function renderWatchHandoff(cards: readonly WrittenCard[], ctx: HandoffContext): string {
  const head = [
    `# Handoff — ${WATCH_PHASE} / ${ctx.stageId} — run ${ctx.runId}`,
    `Stage: ${ctx.stageId} · Expert: ${ctx.experts.join(", ") || "operations"} · Model: ${ctx.model ?? "default"}`
      + ` · Cost: $${ctx.costUsd.toFixed(2)} of $${ctx.budgetUsd.toFixed(2)} ceiling · ${ctx.at}`,
    "",
    "> One watcher card per shipped feature, derived from what Build actually",
    "> instrumented. A `draft` card is not a gap in this stage — it is this stage",
    "> reporting a gap in the code.",
    "",
  ];
  const bodies = new Map<string, readonly string[]>([
    ["Findings", findings(cards)],
    ["Decisions", decisions(cards)],
    ["Unknowns", unknowns(cards)],
    ["Evidence ledger", ledger(cards)],
  ]);
  const out = [...head];
  for (const name of HANDOFF_SECTIONS) {
    out.push(`## ${name}`, "", ...(bodies.get(name) ?? [none(NO_STORIES_SRC)]), "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/** One line per card, with the status it earned. */
function findings(cards: readonly WrittenCard[]): readonly string[] {
  if (cards.length === 0) return [none(NO_STORIES_SRC)];
  return cards.map((written) => {
    const signals = written.card.absentSignals.length;
    const tail = written.card.decidedStatus === "verified"
      ? "every Signal source points at built code"
      : `${String(signals)} Signal source(s) still \`absent:\``;
    return `- \`${written.feature.id}\` (${written.feature.title}) — **${written.card.decidedStatus}**: ${tail} `
      + `[src: ${written.path}:1]`;
  });
}

function decisions(cards: readonly WrittenCard[]): readonly string[] {
  if (cards.length === 0) {
    return [`- **measured** No story reached \`status: done\`, so no feature shipped and no card was written [src: ${NO_STORIES_SRC}]`];
  }
  return cards.map((written) =>
    written.card.decidedStatus === "verified"
      ? `- **measured** \`${written.feature.id}\` is watchable as shipped; the card is verified [src: ${written.path}:1]`
      : `- **measured** \`${written.feature.id}\` stays draft until the code emits a signal; the card names what to instrument [src: ${written.path}:1]`,
  );
}

function unknowns(cards: readonly WrittenCard[]): readonly string[] {
  const drafts = cards.filter((written) => written.card.decidedStatus !== "verified");
  if (cards.length === 0) return [none(NO_STORIES_SRC)];
  if (drafts.length === 0) return [none(`absent:${WATCH_PHASE}/${WATCHERS_DIR}`)];
  return drafts.map((written) =>
    `- \`${written.feature.id}\` is not observable yet: ${written.card.absentSignals.join(", ")} `
    + `— *could be answered by:* instrumenting it, then \`tldrx watch check ${written.feature.id}\` [src: ${written.path}:1]`,
  );
}

function ledger(cards: readonly WrittenCard[]): readonly string[] {
  if (cards.length === 0) return [none(NO_STORIES_SRC)];
  const lines: string[] = [];
  for (const written of cards) {
    for (const story of written.feature.stories) {
      lines.push(
        `- \`${story.story.id}\` (${story.story.repo}) shipped on ${written.feature.epicId} and is what \`${written.feature.id}\` was written from `
        + `[src: ${story.path}:1]`,
      );
    }
  }
  return lines;
}

function none(lookedAt: string): string {
  return `- none [src: ${lookedAt}]`;
}
