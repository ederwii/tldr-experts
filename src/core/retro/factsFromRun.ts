/**
 * The facts this run produced (concept §13: answers become durable memory).
 *
 * Primary source is `.tldrx/memory/facts.yml` read through `FactsStore`, filtered
 * on `source.run` — the field the spec (§2.5) puts there for exactly this. The
 * `fact.added` events are the fallback: an event that names a fact the store does
 * not have means the two files disagree, and the retro says so instead of
 * quietly showing the shorter list.
 */
import { join } from "node:path";
import { FactsStore, isRetired, type Fact } from "../facts/index.ts";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import type { LoadedRun } from "../replay/index.ts";

export interface RunFact {
  readonly id: string;
  readonly text: string;
  /** `[src: F021]` when it is in facts.yml, else the events.jsonl line. */
  readonly src: string;
  readonly retired: boolean;
  /**
   * The fact that replaced this one, or null.
   *
   * A retro is HISTORY, so a superseded fact is shown rather than filtered — but
   * shown labelled. A run that reversed one of its own answers produced both
   * rows, and a retro that listed them side by side with nothing to tell them
   * apart would read as the run having decided two contradictory things.
   */
  readonly supersededBy: string | null;
}

export function factsPath(root: string): string {
  return join(root, PROJECT_FRAMEWORK_DIR, "memory", "facts.yml");
}

export function factsFromRun(loaded: LoadedRun): readonly RunFact[] {
  const stored = loadFacts(loaded.root).filter((fact) => fact.source.run === loaded.id);
  const found: RunFact[] = stored.map((fact) => ({
    id: fact.id,
    text: fact.fact,
    src: `[src: ${fact.id}]`,
    retired: isRetired(fact),
    supersededBy: fact.superseded_by,
  }));
  const seen = new Set(found.map((fact) => fact.id));

  for (const { line, event } of loaded.events) {
    if (event.type !== "fact.added") continue;
    const id = str(event.payload.fact) || str(event.payload.id);
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    found.push({
      id,
      text: str(event.payload.text) || `recorded by ${event.actor}; not present in facts.yml`,
      src: `[src: tldrx-work/${loaded.id}/events.jsonl:${line}]`,
      retired: false,
      supersededBy: null,
    });
  }
  return found;
}

function loadFacts(root: string): readonly Fact[] {
  try {
    return FactsStore.loadOrEmpty(factsPath(root)).facts;
  } catch {
    return [];
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
