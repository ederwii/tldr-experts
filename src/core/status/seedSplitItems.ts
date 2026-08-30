/**
 * Item 2: a proposed split nobody decided.
 *
 * `tldrx seed triage --propose` deliberately creates nothing — it writes
 * `split.yml` at `status: proposed` and stops, because "the model proposed it" and
 * "we are doing it" must not be the same event (spec §6.2). The cost of that
 * separation is that the proposal then sits in a folder nobody re-opens. This is
 * the other half: every `status: proposed` split in the workspace, with the three
 * things a human has to decide about it before `seed apply` means anything —
 *
 *   the questions   the model said out loud it could not answer
 *   the ADRs        documents in the seed still marked `proposed`
 *   the runs        what would be created, and from what
 *
 * The ADR status is read FROM THE DOCUMENT, not from `inventory.json`'s cached
 * `adrStatus`. The inventory supplies the document list — it is the set the
 * proposal was made from — but a status cached at triage time would keep
 * reporting a decision as open for as long as nobody re-ran triage, which is
 * exactly as long as the decision took to make.
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { parseYaml } from "../yaml.ts";
import { statusLineOf } from "../seed/triageInventory.ts";
import { isAnswered, readSplitFile, SPLIT_MD, SPLIT_YML, type SplitFile } from "../seed/splitFile.ts";
import type { PendingItem } from "./PendingItem.ts";

/** Where `seed triage` writes by default (`runTriage.ts`): `.tldrx/triage/<slug>/`. */
export const TRIAGE_DIRNAME = "triage";

/** How many questions / ADRs one item spells out before it stops listing. */
const MAX_LISTED = 5;

/**
 * `[assumption]` — a `Status:` line lives in a document's header block. Reading
 * the first 4 KB of each seed document keeps a 32-file, 350 KB seed to one bounded
 * read per file instead of loading all of it to look at line three.
 */
const STATUS_HEAD_BYTES = 4096;

/** A document in the seed that says it is still `proposed`. */
export interface ProposedDoc {
  readonly rel: string;
  /** The status line as written, e.g. `- Status: proposed — owner decision pending`. */
  readonly line: string;
}

export interface ProposedSplit {
  /** Absolute path of the `split.yml`. */
  readonly path: string;
  /** Workspace-relative path, POSIX — what the printed command names. */
  readonly rel: string;
  readonly dir: string;
  readonly file: SplitFile;
}

/** Every parseable `split.yml` under `.tldrx/triage/` at `status: proposed`, dir order. */
export function proposedSplits(root: string): readonly ProposedSplit[] {
  const triage = join(root, PROJECT_FRAMEWORK_DIR, TRIAGE_DIRNAME);
  let entries: string[];
  try {
    entries = readdirSync(triage).sort();
  } catch {
    return [];
  }
  const found: ProposedSplit[] = [];
  for (const entry of entries) {
    const dir = join(triage, entry);
    const path = join(dir, SPLIT_YML);
    try {
      if (!statSync(dir).isDirectory() || !existsSync(path)) continue;
      const file = readSplitFile(parseYaml(readFileSync(path, "utf8")));
      if (file.status !== "proposed") continue;
      found.push({ path, rel: toRel(root, path), dir, file });
    } catch {
      // A split that does not parse is not pending work — it is a broken file.
      continue;
    }
  }
  return found;
}

export function seedSplitItems(root: string): readonly PendingItem[] {
  return proposedSplits(root).map((split) => splitItem(root, split));
}

function splitItem(root: string, split: ProposedSplit): PendingItem {
  const file = split.file;
  const open = file.questions.filter((question) => !isAnswered(question));
  const rels = seedDocuments(split.dir, file);
  const proposed = proposedDocs(root, split.dir, rels);
  // `[assumption]` — a cheap, documented heuristic: a seed file whose NAME starts
  // `DECISIONS` is where the package collects what it needs decided. It is a
  // convention, not a schema, so it only ever ADDS a pointer to a real file; it
  // never decides whether the split is pending and never suppresses anything.
  const decisions = rels.filter((rel) => /^DECISIONS.*\.md$/i.test(basename(rel)));

  const details: string[] = [
    `${String(file.runs.length)} run(s) would be created: ${file.runs.map((run) => run.slug).join(", ")}`,
  ];

  if (open.length === 0) {
    details.push("no unanswered questions on the split itself");
  } else {
    details.push(`${String(open.length)} question(s) the proposal could not answer:`);
    for (const question of open.slice(0, MAX_LISTED)) {
      details.push(`  ${question.id} ${question.text}`);
    }
    if (open.length > MAX_LISTED) details.push(`  … and ${String(open.length - MAX_LISTED)} more`);
    details.push(`  answer one with \`tldrx seed answer ${split.rel} <Qid> "<text>"\``);
  }

  if (proposed.length > 0) {
    details.push(`${String(proposed.length)} seed document(s) are still \`proposed\` — decisions nobody has made:`);
    // The bullet a document writes its status with (`- Status: …`) is noise once
    // the line is already a bullet in this report.
    for (const doc of proposed.slice(0, MAX_LISTED)) {
      details.push(`  ${doc.rel} — ${doc.line.replace(/^[-*+]\s+/, "")}`);
    }
    if (proposed.length > MAX_LISTED) details.push(`  … and ${String(proposed.length - MAX_LISTED)} more`);
  }
  for (const rel of decisions) details.push(`decisions are collected in ${rel}`);

  details.push(
    `read ${toRel(root, join(split.dir, SPLIT_MD))}, edit ${split.rel} if you disagree, then apply it`,
  );

  return {
    kind: "seed-split",
    summary: `a proposed split of \`${file.source}\` into ${String(file.runs.length)} `
      + "piece(s) of work is waiting for your decision — nothing has been created yet",
    command: `tldrx seed apply ${split.rel} --dry-run`,
    details,
  };
}

/**
 * The seed documents this split was proposed from.
 *
 * `inventory.json` beside the split is the real list — the same file `seed apply`
 * validates the proposal against. Without it, the split's own paths stand in, so a
 * split that was moved still reports on the documents it actually names.
 */
export function seedDocuments(dir: string, file: SplitFile): readonly string[] {
  const inventory = join(dir, "inventory.json");
  if (existsSync(inventory)) {
    try {
      const doc = JSON.parse(readFileSync(inventory, "utf8")) as { documents?: { rel?: unknown }[] };
      const rels = (doc.documents ?? [])
        .map((row) => row.rel)
        .filter((rel): rel is string => typeof rel === "string");
      if (rels.length > 0) return rels;
    } catch {
      // fall through to the split's own paths
    }
  }
  const rels = new Set<string>(file.shared_context);
  for (const entry of file.exclude) rels.add(entry.path);
  for (const run of file.runs) for (const rel of run.seeds) rels.add(rel);
  return [...rels].sort();
}

/** Every seed document whose own `Status:` line still says `proposed`. */
export function proposedDocs(
  root: string,
  dir: string,
  rels: readonly string[],
): readonly ProposedDoc[] {
  const cached = cachedStatuses(dir);
  const found: ProposedDoc[] = [];
  for (const rel of rels) {
    const head = readHead(join(root, rel));
    if (head === null) {
      // Unreadable (moved, or the seed lives outside the workspace): fall back to
      // what triage recorded, which is the only other thing that ever read it.
      if (cached.get(rel) === "proposed") found.push({ rel, line: "Status: proposed (from inventory.json)" });
      continue;
    }
    const status = statusLineOf(head);
    if (status !== null && status.status === "proposed") found.push({ rel, line: status.line });
  }
  return found;
}

/** `rel -> adrStatus` as `seed triage` recorded it, for the unreadable-file case. */
function cachedStatuses(dir: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const inventory = join(dir, "inventory.json");
  if (!existsSync(inventory)) return out;
  try {
    const doc = JSON.parse(readFileSync(inventory, "utf8")) as {
      documents?: { rel?: unknown; adrStatus?: unknown }[];
    };
    for (const row of doc.documents ?? []) {
      if (typeof row.rel === "string" && typeof row.adrStatus === "string") out.set(row.rel, row.adrStatus);
    }
  } catch {
    return out;
  }
  return out;
}

/** The first `STATUS_HEAD_BYTES` of a file as text, or null when it cannot be read. */
function readHead(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(STATUS_HEAD_BYTES);
    const read = readSync(fd, buffer, 0, STATUS_HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function toRel(root: string, path: string): string {
  const rel = relative(root, path);
  return rel === "" || rel.startsWith("..") ? path : rel.split("\\").join("/");
}
