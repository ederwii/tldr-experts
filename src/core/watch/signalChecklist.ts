/**
 * `tldrx watch check` — the watcher card as a post-merge checklist (issue #65).
 *
 * `tldrx ship` opens the PR that carries the handoff. The watcher card lists the
 * signals that would prove the shipped feature works. Nothing joined the two, so
 * "merged ≠ deployed ≠ verified" stayed a thing a person had to remember — and
 * the owner's own CD gap, remembered wrongly, once destroyed 19 records. This is
 * the join, in its cheapest form: a command that reads the cards a run already
 * wrote and prints what somebody now has to go and look at.
 *
 * v1 is MANUAL (owner decision, 2026-09-01). No `gh` detector, no poller, no
 * webhook. That is not a placeholder for one — the detector answers "did the PR
 * merge?", and this file answers "what do I check now?", which is the half that
 * did not exist.
 *
 * ## What is an owner here
 *
 * Three answers, in this order, and the printed line says WHICH one it is showing
 * — because "alice" and "api" answer different questions and a reader who cannot
 * tell them apart is worse off than one who only ever saw the repo.
 *
 *   1. the item's own `(owner: <name>)` annotation (`itemOwner.ts`, gh #70);
 *   2. the card's optional front-matter `owner:` — the same name for every item
 *      on the card, which is the ordinary case for a feature one team runs;
 *   3. DERIVED from the item's own citation: `[src: api:src/Leaderboard.cs:64]`
 *      says the signal is emitted by `api`, and `api` is who to ask.
 *
 * (3) was the whole of v1 and stays the fallback. It is a repo, not a person, and
 * naming it as an owner was the gap gh #70 was filed about — but the fix for that
 * is an OPTIONAL name somebody actually wrote, never a required key the stage
 * would have to invent a value for (the defect `schemaContract.ts:20` and gh #48
 * are both about). An item sourced at a fact or a URL has no repo, and with
 * nothing declared it says nothing rather than borrowing the card's.
 *
 * ## What may be RUN
 *
 * Exactly one thing: a `$ <command> → exit <n>` source whose command
 * `workspace.yml` declares, in a repo the item or the card names unambiguously.
 * That is the card marking it runnable — the `[src: …]` grammar's own `cmd` kind
 * — and it is checked against the workspace allowlist on top, because a card is a
 * document a sub-agent wrote and a document is not a permit.
 *
 * A `## Query` block is NEVER runnable. It is KQL, SQL or whatever the console
 * named under `## Where` speaks; the framework has no such console and no
 * credentials for it, and a query printed with a "run it" affordance that then
 * fails is worse than a query printed plainly.
 *
 * ## Refusals
 *
 * Three, and they are told apart because they need different actions: the run has
 * no Watch phase on disk (it stopped before Watch, or never had the stage), the
 * phase is there and empty (Watch ran and shipped nothing), and the card is a
 * `draft` — which is not a failure at all but an answer: the card's `absent:`
 * sources name what is not instrumented yet, quoted back rather than paraphrased.
 *
 * Reading only. Nothing here writes a byte of the run.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseHandoff, type HandoffBullet } from "../text/handoff.ts";
import type { SrcContext } from "../text/srcToken.ts";
import { runDeclaredCommand, type CommandRun } from "../run/checks.ts";
import { WATCHERS_DIR, WATCH_PHASE, WATCHER_SIGNAL_SECTION } from "./Watcher.ts";
import { itemOwner } from "./itemOwner.ts";
import { queryBlock } from "./watcherFile.ts";
import { checkCard, statusOf, type CheckReport, type LoadedCard } from "./watchViews.ts";

/** How long one re-run of a card's recorded command may take. */
export const SIGNAL_TIMEOUT_S = 120;

/** A `$ <command> → exit <n>` source this workspace is willing to re-run. */
export interface RunnableSignal {
  /** Byte-identical to a `workspace.yml` command. */
  readonly command: string;
  /** The exit code the CARD recorded — what a re-run is compared against. */
  readonly expectExit: number;
  /** The `workspace.yml` repo it runs in. */
  readonly repo: string;
}

/** Where a printed owner came from. `repo` is v1's derivation; `none` is silence. */
export const OWNER_SOURCES = ["item", "card", "repo", "none"] as const;
export type OwnerSource = (typeof OWNER_SOURCES)[number];

/** One item under `## Signal`, as something a person can go and check. */
export interface SignalItem {
  /** 1-based within its card — the number printed in the checkbox. */
  readonly n: number;
  /** The bullet as written, `[src: …]` token and all. Never paraphrased. */
  readonly text: string;
  /** The repos this item's own sources name. Empty when it cites none. */
  readonly owners: readonly string[];
  /**
   * The name somebody WROTE (#70) — the item's annotation, else the card's
   * front matter. Null when neither declared one, which is when `owners` is the
   * answer instead.
   */
  readonly declaredOwner: string | null;
  /** Which of the three answers this item's owner line is showing. */
  readonly ownerSource: OwnerSource;
  /** `absent:` paths under this item — what is NOT instrumented. */
  readonly absent: readonly string[];
  /** Null unless the item cites a command this workspace declares. */
  readonly runnable: RunnableSignal | null;
  /** Why a command-shaped source is not runnable. Null when there is none. */
  readonly printOnly: string | null;
}

/** The fenced `## Query` block, with the language its fence declared. */
export interface CardQuery {
  /** The fence's info string (`kql`, `sql`, …), or "" when it had none. */
  readonly lang: string;
  readonly body: string;
}

/** One card, ready to print. */
export interface CardChecklist {
  readonly id: string;
  /** Path relative to the run dir. */
  readonly path: string;
  readonly title: string;
  readonly epic: string;
  readonly repos: readonly string[];
  /** What `watch list` shows: `verified`, `draft`, `draft (!)`, `invalid`. */
  readonly status: string;
  /** The `absent:` sources that keep this card a draft. Empty when verified. */
  readonly draftBecause: readonly string[];
  readonly signals: readonly SignalItem[];
  readonly where: readonly string[];
  readonly baseline: readonly string[];
  readonly broken: readonly string[];
  readonly query: CardQuery | null;
  /** The citation re-check — the same `checkCard` `watch check <feature>` runs. */
  readonly verdict: CheckReport;
}

/** What one `--execute` re-run did, keyed by `<card id>#<item n>`. */
export type SignalRuns = ReadonlyMap<string, CommandRun>;

export function runKey(cardId: string, n: number): string {
  return `${cardId}#${String(n)}`;
}

/**
 * Why there is nothing to check, or null when there is.
 *
 * The two empty cases are told apart deliberately. "The Watch phase was never
 * written" is a run that stopped early and the action is to finish it; "Watch ran
 * and wrote no card" is a run with no DONE stories and the action is to look at
 * the build. A single "no cards" line would have sent a reader to the wrong one.
 */
export function nothingToCheck(
  runDir: string,
  runId: string,
  cards: readonly LoadedCard[],
): string | null {
  if (cards.length > 0) return null;
  if (!existsSync(join(runDir, WATCH_PHASE))) {
    return `run ${runId} has no ${WATCH_PHASE}/ — its Watch stage never ran, so there is nothing to check`;
  }
  return `run ${runId} ran Watch but wrote no watcher card in ${WATCH_PHASE}/${WATCHERS_DIR}/`
    + " — no story reached `done`, so no feature shipped";
}

/** The card, read into the shape the checklist prints. */
export function cardChecklist(loaded: LoadedCard, ctx: SrcContext): CardChecklist {
  const sections = new Map<string, readonly HandoffBullet[]>();
  for (const section of parseHandoff(loaded.text).sections) {
    if (!sections.has(section.name)) sections.set(section.name, section.bullets);
  }
  const watcher = loaded.card.watcher;
  const repos = watcher?.repos ?? [];
  const signals = (sections.get(WATCHER_SIGNAL_SECTION) ?? [])
    .map((bullet, index) => signalItem(bullet, index + 1, repos, ctx, watcher?.owner ?? null));

  return {
    id: loaded.id,
    path: loaded.path,
    title: watcher?.title ?? "",
    epic: watcher?.epic ?? "",
    repos,
    status: statusOf(loaded),
    draftBecause: loaded.card.absentSignals,
    signals,
    where: texts(sections.get("Where")),
    baseline: texts(sections.get("Healthy baseline")),
    broken: texts(sections.get("Looks broken when")),
    query: cardQuery(loaded.text),
    verdict: checkCard(loaded),
  };
}

function texts(bullets: readonly HandoffBullet[] | undefined): readonly string[] {
  return (bullets ?? []).map((bullet) => bullet.text);
}

function signalItem(
  bullet: HandoffBullet,
  n: number,
  cardRepos: readonly string[],
  ctx: SrcContext,
  cardOwner: string | null,
): SignalItem {
  const refs = bullet.token?.refs ?? [];
  const owners: string[] = [];
  const absent: string[] = [];
  for (const ref of refs) {
    if (ref.kind === "file" && ref.repo !== null && !owners.includes(ref.repo)) owners.push(ref.repo);
    if (ref.kind === "absent") absent.push(ref.path);
  }
  // An `absent:` path is spelled as a path, so its first segment is only an owner
  // when it happens to BE a repo. Guessing beyond that would put a name next to a
  // signal on the strength of a directory that shares its spelling.
  for (const path of absent) {
    const head = path.split("/")[0] ?? "";
    if (ctx.repos.has(head) && !owners.includes(head)) owners.push(head);
  }

  // Item first, then the card, then nothing — the derived repos in `owners` are
  // rendered only when neither named anybody. A malformed annotation is reported
  // by `parseWatcherCard` and declares nobody here, so a lost name can never be
  // quietly replaced by the repo that happens to emit the signal.
  const named = itemOwner(bullet.text).owner;
  const declared = named ?? cardOwner;
  const ownerSource: OwnerSource = named !== null
    ? "item"
    : cardOwner !== null ? "card" : owners.length > 0 ? "repo" : "none";
  const base = { n, text: bullet.text, owners, absent, declaredOwner: declared, ownerSource };

  const cmd = refs.find((ref) => ref.kind === "cmd");
  if (cmd === undefined || cmd.kind !== "cmd") {
    return { ...base, runnable: null, printOnly: null };
  }
  if (!ctx.commands.has(cmd.command)) {
    return {
      ...base, runnable: null,
      printOnly: `\`${cmd.command}\` is not one of workspace.yml's commands — print only`,
    };
  }
  // Which repo to run it IN is not on the source. The item's own file citation
  // answers it; failing that, a card naming exactly one repo answers it; a card
  // naming several does not, and a coin toss here runs a command in the wrong
  // checkout.
  const repo = owners[0] ?? (cardRepos.length === 1 ? cardRepos[0] : undefined);
  if (repo === undefined) {
    return {
      ...base, runnable: null,
      printOnly: `the card names ${String(cardRepos.length)} repos and this item names none`
        + " — which repo to run it in is a guess, so it is print only",
    };
  }
  return {
    ...base,
    runnable: { command: cmd.command, expectExit: cmd.exitCode, repo },
    printOnly: null,
  };
}

/** The first fenced block under `## Query`, with the language its fence declared. */
export function cardQuery(text: string): CardQuery | null {
  const body = queryBlock(text);
  if (body === null) return null;
  return { lang: fenceLang(text), body };
}

function fenceLang(text: string): string {
  let inSection = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      inSection = line.slice(3).trim() === "Query";
      continue;
    }
    if (!inSection) continue;
    const open = /^\s*(?:`{3,}|~{3,})\s*(\S*)/.exec(line);
    if (open !== null) return open[1] ?? "";
  }
  return "";
}

/**
 * Re-run every runnable signal, in order.
 *
 * Serial on purpose: these are a workspace's own build and test commands, and
 * running two of them at once in the same checkout is how a "flaky" result gets
 * manufactured. There are never many — a card has a handful of signals.
 */
export async function executeSignals(
  root: string,
  lists: readonly CardChecklist[],
): Promise<SignalRuns> {
  const runs = new Map<string, CommandRun>();
  for (const list of lists) {
    for (const item of list.signals) {
      if (item.runnable === null) continue;
      runs.set(runKey(list.id, item.n), await runDeclaredCommand(
        root, item.runnable.command, item.runnable.repo, item.runnable.expectExit, SIGNAL_TIMEOUT_S,
      ));
    }
  }
  return runs;
}

/** True when every card validates and every re-run matched what the card recorded. */
export function checklistOk(lists: readonly CardChecklist[], runs: SignalRuns): boolean {
  for (const list of lists) {
    if (!list.verdict.ok) return false;
    for (const item of list.signals) {
      const run = runs.get(runKey(list.id, item.n));
      if (run !== undefined && !run.ok) return false;
    }
  }
  return true;
}

/** Under a `## Where` / `## Healthy baseline` bullet. */
const SECTION_INDENT = "    ";
/** Under a signal's own text: 4 spaces plus the width of `1. [ ] `. */
const ITEM_INDENT = "           ";

/** The screen. One block per card, in the order `loadCards` found them. */
export function renderChecklist(
  runId: string,
  lists: readonly CardChecklist[],
  runs: SignalRuns = new Map(),
): string {
  const out: string[] = [
    `Post-merge checks — run ${runId}`,
    "",
    "What the run's watcher cards say would prove the shipped features still work.",
    "Nothing below is automatic: this is the list, not the verdict.",
    "",
  ];
  for (const list of lists) out.push(...cardBlock(list, runs), "");
  out.push(summary(lists, runs), "");
  return out.join("\n");
}

function cardBlock(list: CardChecklist, runs: SignalRuns): readonly string[] {
  const head = [`${list.id} · ${list.title}`.trimEnd(), `[${list.status}]`];
  if (list.epic !== "") head.push(`epic ${list.epic}`);
  if (list.repos.length > 0) head.push(`repos ${list.repos.join(", ")}`);
  const out: string[] = [head.join("  "), `  ${list.path}`, ""];

  out.push("  Signal — what proves it works");
  if (list.signals.length === 0) out.push(`${SECTION_INDENT}(the card holds no Signal item)`);
  for (const item of list.signals) out.push(...signalLines(list, item, runs));

  out.push(...section("Where it is read", list.where));
  out.push(...section("Healthy baseline", list.baseline));
  out.push(...section("Looks broken when", list.broken));

  if (list.query !== null) {
    const lang = list.query.lang === "" ? "" : ` (${list.query.lang})`;
    out.push(
      "",
      `  Query${lang} — print only: it runs in the console named under "Where it is read",`,
      "  not here, so it is reproduced rather than offered.",
    );
    for (const line of list.query.body.split("\n")) out.push(`${SECTION_INDENT}${line}`);
  }

  if (list.draftBecause.length > 0) {
    out.push(
      "",
      `  DRAFT — ${String(list.draftBecause.length)} of ${String(list.signals.length)} signals on this card`
      + `${list.draftBecause.length === 1 ? " cites" : " cite"} \`absent:\`, so the card cannot tell`,
      "  you the feature works. It names what to instrument instead:",
      ...list.draftBecause.map((path) => `${SECTION_INDENT}absent:${path}`),
    );
  }
  if (!list.verdict.ok) out.push("", ...list.verdict.lines.map((line) => `  ${line}`));
  else out.push("", `  ${list.verdict.lines.slice(1).join("\n  ").trim()}`);
  return out;
}

function signalLines(list: CardChecklist, item: SignalItem, runs: SignalRuns): readonly string[] {
  const box = item.absent.length > 0 ? "[!]" : "[ ]";
  const out = [`    ${String(item.n)}. ${box} ${item.text}`];
  const owner = ownerLine(item);
  if (owner !== null) out.push(`${ITEM_INDENT}${owner}`);
  for (const path of item.absent) {
    out.push(`${ITEM_INDENT}NOT INSTRUMENTED — the card cites absent:${path}, nothing to check`);
  }
  if (item.printOnly !== null) out.push(`${ITEM_INDENT}${item.printOnly}`);

  const run = runs.get(runKey(list.id, item.n));
  if (item.runnable !== null && run === undefined) {
    out.push(
      `${ITEM_INDENT}runnable: \`${item.runnable.command}\` in ${item.runnable.repo}`
      + ` — the card recorded exit ${String(item.runnable.expectExit)};`,
      `${ITEM_INDENT}re-run it with \`tldrx watch check --execute\``,
    );
  }
  if (item.runnable !== null && run !== undefined) {
    const got = run.exitCode === null ? (run.timedOut ? "timed out" : "did not start") : `exit ${String(run.exitCode)}`;
    out.push(
      `${ITEM_INDENT}ran: \`${item.runnable.command}\` in ${item.runnable.repo} → ${got}`
      + ` (card recorded exit ${String(item.runnable.expectExit)}) — ${run.ok ? "unchanged" : "CHANGED"}`,
    );
    if (!run.ok) out.push(`${ITEM_INDENT}${run.detail}`);
  }
  return out;
}

/**
 * The one `owner:` line an item gets, or null when nothing can say who owns it.
 *
 * A DECLARED name says where it was declared, because a reader deciding whom to
 * page needs to know whether a human wrote that word or the framework derived it.
 * The derived form is left byte-identical to what `watch check` printed before
 * #70 — a card that declares nothing must read exactly as it did yesterday.
 */
function ownerLine(item: SignalItem): string | null {
  if (item.declaredOwner !== null) {
    const where = item.ownerSource === "item" ? "declared on the item" : "declared on the card";
    return `owner: ${item.declaredOwner} (${where})`;
  }
  if (item.owners.length > 0) return `owner: ${item.owners.join(", ")}`;
  return null;
}

function section(title: string, items: readonly string[]): readonly string[] {
  if (items.length === 0) return [];
  return ["", `  ${title}`, ...items.map((item) => `${SECTION_INDENT}- ${item}`)];
}

function summary(lists: readonly CardChecklist[], runs: SignalRuns): string {
  const signals = lists.reduce((sum, list) => sum + list.signals.length, 0);
  const runnable = lists.reduce(
    (sum, list) => sum + list.signals.filter((item) => item.runnable !== null).length, 0,
  );
  const drafts = lists.filter((list) => list.draftBecause.length > 0).length;
  const changed = [...runs.values()].filter((run) => !run.ok).length;
  const parts = [
    `${String(lists.length)} card(s)`,
    `${String(signals)} signal(s)`,
    `${String(runnable)} runnable`,
  ];
  if (drafts > 0) parts.push(`${String(drafts)} draft`);
  if (runs.size > 0) parts.push(`${String(runs.size)} re-run, ${String(changed)} changed`);
  return parts.join(" · ");
}
