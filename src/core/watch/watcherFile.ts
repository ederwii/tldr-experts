/**
 * Reading, checking and re-stamping one watcher card.
 *
 * The section half reuses the handoff parser (`src/core/text/handoff.ts`) rather
 * than growing a second one. That is not tidiness: `claim-sources` denies a
 * handoff bullet using exactly that parser and exactly that `[src: …]` grammar, so
 * a card checked by a different reader would drift from the rule the hook
 * enforces, and the drift would show up as a card that passes `watch check` and is
 * denied on write.
 *
 * The status is set HERE, deterministically, and never taken from the model: a
 * card is `verified` only when nothing under `## Signal` cites `absent:`. Asking a
 * sub-agent to grade its own coverage is how an aspirational watcher gets a green
 * badge.
 */
import { parseHandoff, type HandoffSection } from "../text/handoff.ts";
import { resolveSrc, type SrcContext } from "../text/srcToken.ts";
import { parseFrontMatter } from "../schemas/frontMatter.ts";
import type { ValidationIssue } from "../schemas/validation.ts";
import {
  asWatcher, validateWatcher, WATCHER_CHECKED_SECTIONS, WATCHER_SECTIONS, WATCHER_SIGNAL_SECTION,
  type Watcher, type WatcherStatus,
} from "./Watcher.ts";
import { itemOwner } from "./itemOwner.ts";

/**
 * `shape` — the card is malformed: a section missing, an item with no token, a
 * `## Query` with nothing to paste. `source` — the card is well formed but one of
 * its citations does not parse or no longer resolves.
 *
 * The split is not cosmetic: a shape problem means the sub-agent wrote the card
 * wrong and the stage should fail; a source problem is usually the CODE moving
 * under a card written months ago, which is exactly what `watch check` is for.
 */
export type WatcherIssueKind = "shape" | "source";

export interface WatcherIssue extends ValidationIssue {
  /** 1-based line in the card, or 0 when the issue is about the file as a whole. */
  readonly line: number;
  readonly kind: WatcherIssueKind;
}

/**
 * A citation that resolves, and resolves ONLY somewhere unmerged (gh #143).
 *
 * Kept off `issues` deliberately, and as its own list rather than a third
 * `WatcherIssueKind`: every issue this file records makes `ok` false, and this
 * one must not. A card whose Signal cites the epic's own code is the ORDINARY
 * card — the Watch stage's whole subject is code that nothing has merged (#16) —
 * so refusing it would refuse a card for being right.
 *
 * What #140 refuses is the SILENCE, and until now the cards were the one artefact
 * it could not reach: `tldrx watch` and `watch arm` opt into the epic refs
 * (`toSrcContext(…, { epicRefs: true })`), so such a citation resolved and nobody
 * was told which branch it resolved on. This is the list that names the branch,
 * shaped exactly like `handoff.ts`'s `epicOnly` so the two readers cannot drift.
 */
export interface WatcherEpicOnly extends ValidationIssue {
  /** 1-based line in the card. */
  readonly line: number;
  /** The unmerged ref it resolved on — `SrcResolution.unmerged`, verbatim. */
  readonly src: string;
}

export interface WatcherCard {
  /** Null when the front matter is missing or does not validate. */
  readonly watcher: Watcher | null;
  /** Everything wrong with the card. Empty means it may be written as-is. */
  readonly issues: readonly WatcherIssue[];
  /**
   * Citations that resolve only on an unmerged ref (gh #143). Non-fatal, and
   * excluded from `ok` by construction — it is a separate list, not an issue.
   */
  readonly epicOnly: readonly WatcherEpicOnly[];
  /** The status the card DESERVES, computed from its Signal sources. */
  readonly decidedStatus: WatcherStatus;
  /** Signal items citing `absent:` — the reason a card stays `draft`. */
  readonly absentSignals: readonly string[];
  /** The first line under `## Signal`, for the `watch list` table. */
  readonly signalLine: string | null;
  readonly ok: boolean;
}

/**
 * `[assumption]` — spec §2.8 confines a `$ <cmd> → exit <n>` source to a handoff's
 * `Evidence ledger`, because the other three sections are claims and the ledger is
 * the proof. A watcher card has no such split: every section on it is proof about
 * a running system, and "the baseline is 40/hour `[src: $ … → exit 0]`" is the
 * most honest form that claim takes. So the card's checked sections are resolved
 * under the ledger's name, and a `cmd` source is legal anywhere on a card.
 */
const SRC_SECTION = "Evidence ledger";

export function parseWatcherCard(text: string, ctx: SrcContext, fileStem?: string): WatcherCard {
  const issues: WatcherIssue[] = [];
  const parsed = parseFrontMatter(text);
  let watcher: Watcher | null = null;

  if (parsed.issue !== null) {
    issues.push({ ...parsed.issue, line: 1, kind: "shape" });
  } else {
    const validation = validateWatcher(parsed.doc);
    for (const issue of validation.issues) issues.push({ ...issue, line: 1, kind: "shape" });
    if (validation.ok) watcher = asWatcher(parsed.doc);
  }
  if (watcher !== null && fileStem !== undefined && watcher.id !== fileStem) {
    issues.push({
      path: "id",
      line: 1,
      kind: "shape",
      message: `\`${watcher.id}\` does not match the file name \`${fileStem}.md\` — a card is addressed by its feature id`,
    });
  }

  const handoff = parseHandoff(text);
  const byName = new Map<string, HandoffSection>();
  for (const section of handoff.sections) {
    if (!byName.has(section.name)) byName.set(section.name, section);
  }

  for (const required of WATCHER_SECTIONS) {
    if (byName.has(required)) continue;
    issues.push({ path: required, line: 0, kind: "shape", message: `the card is missing \`## ${required}\`` });
  }

  const absentSignals: string[] = [];
  const epicOnly: WatcherEpicOnly[] = [];
  let signalLine: string | null = null;

  for (const name of WATCHER_CHECKED_SECTIONS) {
    const section = byName.get(name);
    if (section === undefined) continue;
    if (section.bullets.length === 0) {
      issues.push({
        path: name,
        line: section.headingLine,
        kind: "shape",
        message: `\`## ${name}\` holds no list item — write \`- none [src: absent:<what you looked at>]\` if there is genuinely nothing`,
      });
      continue;
    }
    for (const bullet of section.bullets) {
      if (name === WATCHER_SIGNAL_SECTION && signalLine === null) signalLine = bullet.text;
      // `(owner: …)` is optional (#70), so its ABSENCE says nothing. A present one
      // that cannot be read is a shape problem: the stage meant to name a person
      // and the reader would otherwise be handed a repo in their place.
      const owner = itemOwner(bullet.text);
      if (owner.malformed) {
        issues.push({ path: name, line: bullet.line, kind: "shape", message: `owner annotation — ${owner.reason}` });
      }
      if (bullet.token === null) {
        issues.push({ path: name, line: bullet.line, kind: "shape", message: "no `[src: …]` token — every item on a card is sourced" });
        continue;
      }
      for (const error of bullet.token.errors) {
        issues.push({ path: name, line: bullet.line, kind: "source", message: `[src: ${error.raw}] — ${error.message}` });
      }
      for (const ref of bullet.token.refs) {
        if (name === WATCHER_SIGNAL_SECTION && ref.kind === "absent") absentSignals.push(ref.path);
        const resolution = resolveSrc(ref, ctx, SRC_SECTION);
        if (resolution.ok) {
          // `ok`, and true of nothing merged (gh #143/#140). Named here, never
          // pushed to `issues`: the citation is right, and a reader of the trunk
          // still has to be told which branch to look on.
          if (resolution.unmerged !== undefined) {
            epicOnly.push({
              path: name,
              line: bullet.line,
              src: resolution.unmerged,
              message: `[src: ${ref.raw}] — ${resolution.message ?? "resolves on an unmerged ref"}`,
            });
          }
          continue;
        }
        issues.push({ path: name, line: bullet.line, kind: "source", message: `[src: ${ref.raw}] — ${resolution.message ?? "unresolvable"}` });
      }
    }
  }

  const query = queryBlock(text);
  if (byName.has("Query") && query === null) {
    issues.push({
      path: "Query",
      line: byName.get("Query")?.headingLine ?? 0,
      kind: "shape",
      message: "`## Query` holds no fenced block — the query has to be copy-pasteable, not described",
    });
  }

  const decidedStatus: WatcherStatus = absentSignals.length === 0 ? "verified" : "draft";
  // `ok` reads `issues` and nothing else, so `epicOnly` cannot fail a card no
  // matter how long it gets — which is the whole point of it being a second list.
  return { watcher, issues, epicOnly, decidedStatus, absentSignals, signalLine, ok: issues.length === 0 };
}

/** The distinct unmerged refs a card's citations resolved on, in first-seen order. */
export function unmergedRefsOf(card: WatcherCard): readonly string[] {
  return [...new Set(card.epicOnly.map((note) => note.src))];
}

/**
 * The one phrase every card surface prints, or null when the card cites nothing
 * unmerged.
 *
 * Spelled to match `claim-sources`' detail (`checks.ts`: `on unmerged refs: 4
 * (epic/money-and-payments — unmerged)`) on purpose — a reader who has learned
 * that sentence at a gate should not have to learn a second one at a card.
 */
export function describeUnmergedRefs(card: WatcherCard): string | null {
  if (card.epicOnly.length === 0) return null;
  const refs = unmergedRefsOf(card).map((ref) => `${ref} — unmerged`).join(", ");
  return `on unmerged refs: ${String(card.epicOnly.length)} (${refs})`;
}

/** The first fenced block under `## Query`, without its fences. Null when there is none. */
export function queryBlock(text: string): string | null {
  const lines = text.split("\n");
  let inSection = false;
  let fence: string | null = null;
  const body: string[] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (fence !== null) break;
      inSection = line.slice(3).trim() === "Query";
      continue;
    }
    if (!inSection) continue;
    if (fence === null) {
      const open = /^\s*(`{3,}|~{3,})/.exec(line);
      if (open !== null && open[1] !== undefined) fence = open[1];
      continue;
    }
    if (line.trimStart().startsWith(fence)) return body.join("\n");
    body.push(line);
  }
  return null;
}

/**
 * Rewrite the front matter's `status:` in place.
 *
 * A line edit rather than a YAML round-trip on purpose: the card is a document a
 * human reads, and re-emitting its front matter would reorder keys and drop the
 * comments a template put there. Only the one line the framework owns changes.
 */
export function setWatcherStatus(text: string, status: WatcherStatus): string {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trimEnd() !== "---") return text;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trimEnd() === "---") break;
    if (!/^status:\s/.test(line)) continue;
    const comment = line.indexOf("#", line.indexOf(":") + 1);
    lines[i] = comment === -1 ? `status: ${status}` : `status: ${status} ${line.slice(comment)}`;
    return lines.join("\n");
  }
  return text;
}

/** One line per issue, ready for a check `detail` or a CLI report. */
export function describeWatcherIssues(issues: readonly WatcherIssue[], max = 5): readonly string[] {
  const shown = issues.slice(0, max).map((issue) =>
    `  L${String(issue.line)}${issue.path === "" ? "" : ` ${issue.path}`}: ${issue.message}`,
  );
  const rest = issues.length - shown.length;
  return rest > 0 ? [...shown, `  (+${String(rest)} more)`] : shown;
}
