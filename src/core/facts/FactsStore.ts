/**
 * Read/write access to `.tldrx/memory/facts.yml` (spec §2.5).
 *
 * Append-mostly: a fact is superseded or retired, never edited. Every mutation
 * keeps the file valid — supersede writes BOTH ends of the link, so the
 * reciprocity rule can never be broken by going through this class.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseYaml } from "../yaml.ts";
import { withWorkspaceLock, workspaceRootOfFactsPath } from "../lock/workspaceLock.ts";
import {
  formatFactId, factNumber, isRetired, MAX_FACT_CHARS,
  type Fact, type FactRetirement, type FactsFile, type NewFact,
} from "./Fact.ts";
import { asFactsFile, validateFactsFile } from "./validateFactsFile.ts";
import { noteDeprecations } from "../schemas/deprecationNotice.ts";
import { emitFactsYaml } from "./emitFactsYaml.ts";
import { findDuplicate, type DuplicateHit } from "./findDuplicate.ts";

/** Header comment written above a facts.yml this store creates from nothing. */
const NEW_FILE_HEADER =
  "# .tldrx/memory/facts.yml — durable, provenanced answers (spec §2.5).\n" +
  "# Append-mostly: supersede or retire, never edit. A fact without a source is not a fact.";

export class FactsStore {
  private rows: Fact[];

  private constructor(
    readonly path: string,
    readonly version: number,
    rows: readonly Fact[],
  ) {
    this.rows = [...rows];
  }

  /** Load and validate. Throws on a schema error — callers decide whether that is fatal. */
  static load(path: string): FactsStore {
    const text = readFileSync(path, "utf8");
    const doc = parseYaml(text);
    const validation = validateFactsFile(doc);
    noteDeprecations(path, validation);
    if (!validation.ok) {
      const first = validation.issues[0];
      throw new Error(`invalid facts.yml (${path}): ${first?.path ?? ""} ${first?.message ?? "schema error"}`);
    }
    const file = asFactsFile(doc);
    return new FactsStore(path, file.version, file.facts);
  }

  /** Load, or start an empty store when the file does not exist yet. */
  static loadOrEmpty(path: string): FactsStore {
    if (!existsSync(path)) return new FactsStore(path, 1, []);
    return FactsStore.load(path);
  }

  get facts(): readonly Fact[] {
    return this.rows;
  }

  /** Everything the no-re-ask hook is allowed to match against. */
  get active(): readonly Fact[] {
    return this.rows.filter((f) => !isRetired(f));
  }

  get(id: string): Fact | undefined {
    return this.rows.find((f) => f.id === id);
  }

  nextId(): string {
    const highest = this.rows.reduce((max, f) => Math.max(max, factNumber(f.id)), 0);
    return formatFactId(highest + 1);
  }

  /** Append a new fact and return it, with the id the store assigned. */
  append(input: NewFact): Fact {
    const fact: Fact = {
      id: this.nextId(),
      fact: input.fact.length > MAX_FACT_CHARS ? `${input.fact.slice(0, MAX_FACT_CHARS - 1)}…` : input.fact,
      area: input.area,
      repos: [...input.repos],
      kind: input.kind,
      confidence: input.confidence,
      source: { ...input.source },
      supersedes: input.supersedes ?? null,
      superseded_by: null,
      retired: input.retired ?? null,
    };
    this.rows.push(fact);
    return fact;
  }

  /**
   * Append `input` as the replacement for `oldId`, writing both halves of the link.
   * Spec §2.5: the chain is single-link and reciprocal.
   */
  supersede(oldId: string, input: NewFact): Fact {
    const index = this.rows.findIndex((f) => f.id === oldId);
    if (index === -1) throw new Error(`cannot supersede ${oldId}: no such fact`);
    const old = this.rows[index] as Fact;
    if (old.superseded_by !== null) {
      throw new Error(`${oldId} is already superseded by ${old.superseded_by}`);
    }
    if (isRetired(old)) throw new Error(`${oldId} is retired; a retired fact is not superseded`);
    const replacement = this.append({ ...input, supersedes: oldId });
    this.rows[index] = { ...old, superseded_by: replacement.id };
    return replacement;
  }

  /** Retire a fact: no-re-ask ignores it, replay still sees it. */
  retire(id: string, retirement: FactRetirement): Fact {
    const index = this.rows.findIndex((f) => f.id === id);
    if (index === -1) throw new Error(`cannot retire ${id}: no such fact`);
    const fact = this.rows[index] as Fact;
    if (fact.superseded_by !== null) {
      throw new Error(`${id} is superseded by ${fact.superseded_by}; a superseded fact is not retired`);
    }
    const retired: Fact = { ...fact, retired: retirement };
    this.rows[index] = retired;
    return retired;
  }

  findDuplicate(question: string, area: string, threshold?: number): DuplicateHit | null {
    return findDuplicate(question, area, this.active, threshold);
  }

  toFile(): FactsFile {
    return { version: this.version, facts: this.rows };
  }

  toYaml(): string {
    return emitFactsYaml(this.toFile(), existsSync(this.path) ? undefined : NEW_FILE_HEADER);
  }

  /**
   * Rewrite the file, atomically, under the workspace lock. `[assumption]` — the
   * whole document is re-emitted, so any hand-written comments below the header
   * are lost. The spec calls facts.yml append-mostly and machine-owned; nothing
   * in it says comments must survive.
   *
   * The lock here closes the WRITE half of the race. It does not close the
   * read-modify-write half on its own — for that the load has to be inside the
   * same lock, which is what `FactsStore.update` is for, and what every caller
   * that appends should use.
   */
  save(path: string = this.path): void {
    const text = this.toYaml();
    const validation = validateFactsFile(parseYaml(text));
    if (!validation.ok) {
      const first = validation.issues[0];
      throw new Error(`refusing to write an invalid facts.yml: ${first?.path ?? ""} ${first?.message ?? ""}`);
    }
    withWorkspaceLock(workspaceRootOfFactsPath(path), () => {
      writeFactsAtomic(path, text);
    });
  }

  /**
   * Load → mutate → save, all inside ONE workspace lock.
   *
   * This is the only safe way to APPEND. `nextId()` is `max(id) + 1` read off the
   * file, so two processes that load, then both append, both mint the same id and
   * the second write erases the first fact entirely — measured 2026-08-29, two
   * writers each minted `F001`. Holding the lock across the load makes the
   * sequence a real read-modify-write.
   *
   * The callback's return value comes back to the caller, so an appender can hand
   * out the fact it just created without reaching for the store again.
   */
  static update<T>(path: string, fn: (store: FactsStore) => T): T {
    return withWorkspaceLock(workspaceRootOfFactsPath(path), () => {
      const store = FactsStore.loadOrEmpty(path);
      const value = fn(store);
      store.save(path);
      return value;
    });
  }
}

/** Temp + rename: a reader sees the whole old file or the whole new one. */
function writeFactsAtomic(path: string, text: string): void {
  const temp = `${path}.tmp-${String(process.pid)}`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temp, text, "utf8");
    renameSync(temp, path);
  } catch (error) {
    try {
      if (existsSync(temp)) rmSync(temp, { force: true });
    } catch {
      // Nothing to clean up, or not ours to clean up.
    }
    throw error;
  }
}
