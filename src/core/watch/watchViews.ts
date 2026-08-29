/**
 * `tldrx watch list` and `tldrx watch check <feature>` — read-only.
 *
 * `list` exists because the cards' whole value is comparative: three verified and
 * one draft is a different situation from four verified, and neither is legible
 * from a folder of Markdown. `check` exists because a card rots. Its `[src: …]`
 * tokens point at line numbers in code that keeps moving, so "this card still
 * resolves" is a question worth being able to ask on a Tuesday, months after the
 * run that wrote it closed — and it is the same question `tldrx approve` asks at
 * the gate, run by the same parser, so the two cannot disagree.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SrcContext } from "../text/srcToken.ts";
import { WATCHERS_DIR, WATCH_PHASE } from "./Watcher.ts";
import { describeWatcherIssues, parseWatcherCard, type WatcherCard } from "./watcherFile.ts";

export interface LoadedCard {
  /** The file name stem — the feature id a `watch check` takes. */
  readonly id: string;
  /** Path relative to the run dir. */
  readonly path: string;
  readonly card: WatcherCard;
}

export function watchersDir(runDir: string): string {
  return join(runDir, WATCH_PHASE, WATCHERS_DIR);
}

/** Every card in a run, by file name. Cards that do not validate are included. */
export function loadCards(runDir: string, ctx: SrcContext): readonly LoadedCard[] {
  const dir = watchersDir(runDir);
  if (!existsSync(dir)) return [];
  const cards: LoadedCard[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const id = name.slice(0, -".md".length);
    const text = readFileSync(join(dir, name), "utf8");
    cards.push({ id, path: `${WATCH_PHASE}/${WATCHERS_DIR}/${name}`, card: parseWatcherCard(text, ctx, id) });
  }
  return cards;
}

/**
 * The table. The Signal line is shown in full rather than elided at a fixed width:
 * a signal is a log line or a metric name, and half of one identifies nothing.
 */
export function renderWatchList(runId: string, cards: readonly LoadedCard[]): string {
  if (cards.length === 0) {
    return `No watcher cards in run ${runId} — ${WATCH_PHASE}/${WATCHERS_DIR}/ is empty or absent.\n`;
  }
  const rows = cards.map((loaded) => ({
    id: loaded.id,
    status: statusOf(loaded),
    signal: loaded.card.signalLine ?? "(no Signal item)",
  }));
  const idWidth = Math.max(7, ...rows.map((r) => r.id.length));
  const statusWidth = Math.max(6, ...rows.map((r) => r.status.length));
  const out = [
    `Watchers — run ${runId}`,
    "",
    `${pad("FEATURE", idWidth)}  ${pad("STATUS", statusWidth)}  SIGNAL`,
    `${"-".repeat(idWidth)}  ${"-".repeat(statusWidth)}  ------`,
    ...rows.map((r) => `${pad(r.id, idWidth)}  ${pad(r.status, statusWidth)}  ${r.signal}`),
    "",
  ];
  const verified = cards.filter((c) => statusOf(c) === "verified").length;
  const broken = cards.filter((c) => !c.card.ok).length;
  out.push(
    `${String(cards.length)} card(s): ${String(verified)} verified, `
    + `${String(cards.length - verified)} draft${broken === 0 ? "" : `, ${String(broken)} not validating`}`,
    "",
  );
  return out.join("\n");
}

/** What `list` shows: the stamped status, or `invalid` when the card does not parse. */
export function statusOf(loaded: LoadedCard): string {
  if (loaded.card.watcher === null) return "invalid";
  if (!loaded.card.ok) return `${loaded.card.watcher.status} (!)`;
  return loaded.card.watcher.status;
}

export interface CheckReport {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

/**
 * Re-validate one card. Two distinct failures, reported apart: the card is
 * malformed (or cites something that no longer resolves), and the card's stamped
 * status disagrees with what its Signal sources now earn — which is what a card
 * hand-edited to `verified` looks like.
 */
export function checkCard(loaded: LoadedCard): CheckReport {
  const lines: string[] = [`${loaded.path}`];
  const issues = loaded.card.issues;
  if (issues.length > 0) {
    const dead = issues.filter((issue) => issue.kind === "source").length;
    const shape = issues.length - dead;
    const parts: string[] = [];
    if (dead > 0) parts.push(`${String(dead)} citation(s) that no longer resolve`);
    if (shape > 0) parts.push(`${String(shape)} problem(s) with the card itself`);
    lines.push(`  ${parts.join(", ")}:`, ...describeWatcherIssues(issues));
    return { ok: false, lines };
  }
  const stamped = loaded.card.watcher?.status ?? "draft";
  if (stamped !== loaded.card.decidedStatus) {
    lines.push(
      `  status is \`${stamped}\` but its Signal sources earn \`${loaded.card.decidedStatus}\``
      + (loaded.card.decidedStatus === "draft"
        ? ` — still absent: ${loaded.card.absentSignals.join(", ")}`
        : " — re-run the stage or fix the front matter"),
    );
    return { ok: false, lines };
  }
  lines.push(
    `  ok — ${stamped}; every source resolves`
    + (loaded.card.signalLine === null ? "" : `\n  signal: ${loaded.card.signalLine}`),
  );
  return { ok: true, lines };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}
