/**
 * `owner:` on a watcher card's Signal items (gh #70).
 *
 * `watch check` v1 DERIVED an owner from each item's own citation: `[src:
 * api:src/Leaderboard.cs:64]` → `api`. That answers "which repo emits this
 * signal", which is not "who gets paged when it stops" — the question #70 was
 * filed about.
 *
 * The owner decision of 2026-09-01: an OPTIONAL `owner:` per item, filled by the
 * watcher stage from the ledger that already names owners, printed by `watch
 * check`, with the repo-derived answer staying as the fallback when none is
 * declared. Every assertion below is one half of that sentence:
 *
 *   - optional and ADDITIVE — a card written before this exists still validates,
 *     and still prints exactly the line it printed yesterday;
 *   - declared beats derived, and the card says WHICH it is showing, because
 *     "alice" and "api" are answers to different questions;
 *   - an owner is never invented: a malformed annotation is a shape issue, not a
 *     silently dropped name.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fact } from "../src/core/facts/Fact.ts";
import type { Feature } from "../src/core/watch/features.ts";
import type { SrcContext } from "../src/core/text/srcToken.ts";
import { clearSrcCaches } from "../src/core/text/srcToken.ts";
import {
  asWatcher, cardChecklist, featureBrief, itemOwner, loadCards, renderChecklist, renderWatchFacts,
  validateWatcher, WATCH_FACT_AREAS, watcherRelPath,
} from "../src/core/watch/index.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
  clearSrcCaches();
});

const SOURCE = [
  "public sealed class LeaderboardRefresher",
  "{",
  '    public void Refresh() => _log.LogInformation("leaderboard.refreshed");',
  "}",
  "",
].join("\n");

const DERIVED_SIGNAL =
  "- `leaderboard.refreshed` is written on every refresh [src: api:src/Leaderboard.cs:3]";

interface CardOptions {
  readonly owner?: string;
  readonly signals?: readonly string[];
}

function card(options: CardOptions = {}): string {
  return [
    "---",
    "version: 1",
    "id: leaderboard",
    "epic: E1",
    'title: "Player leaderboard"',
    "stories: [S1]",
    "repos: [api]",
    ...(options.owner === undefined ? [] : [`owner: ${options.owner}`]),
    "status: verified",
    "---",
    "",
    "# leaderboard · Player leaderboard",
    "",
    "## Signal",
    ...(options.signals ?? [DERIVED_SIGNAL]),
    "",
    "## Where",
    "- Application Insights → `traces`, filtered to that message [src: api:src/Leaderboard.cs:1]",
    "",
    "## Healthy baseline",
    "- 12-40 refreshes/hour in business hours, measured 2026-08-29 [src: api:src/Leaderboard.cs:1]",
    "",
    "## Looks broken when",
    "- Zero refreshes for 30 minutes while hunts complete [src: api:src/Leaderboard.cs:1]",
    "",
    "## Query",
    "",
    "```kql",
    "traces",
    "```",
    "",
    "## Sources",
    "",
    "One emit site.",
    "",
  ].join("\n");
}

function fixture(text: string): { readonly runDir: string; readonly ctx: SrcContext } {
  const root = mkdtempSync(join(tmpdir(), "tldrx-owner-"));
  dirs.push(root);
  mkdirSync(join(root, "api", "src"), { recursive: true });
  writeFileSync(join(root, "api", "src", "Leaderboard.cs"), SOURCE, "utf8");
  const runDir = join(root, "tldrx-work", "260901-leaderboard");
  const cardPath = join(runDir, watcherRelPath("leaderboard"));
  mkdirSync(join(cardPath, ".."), { recursive: true });
  writeFileSync(cardPath, text, "utf8");
  return { runDir, ctx: { root, repos: new Map([["api", "api"]]), commands: new Set<string>(), runDir } };
}

function checklist(text: string) {
  const { runDir, ctx } = fixture(text);
  const loaded = loadCards(runDir, ctx);
  const first = loaded[0];
  if (first === undefined) throw new Error("the fixture wrote no card");
  return { loaded: first, list: cardChecklist(first, ctx), ctx, runDir };
}

function render(text: string): string {
  const { runDir, ctx } = fixture(text);
  const cards = loadCards(runDir, ctx);
  return renderChecklist("260901-leaderboard", cards.map((one) => cardChecklist(one, ctx)));
}

describe("the annotation itself", () => {
  test("`(owner: alice)` before the token is read, and the item keeps its words", () => {
    const parsed = itemOwner("- the counter is emitted (owner: alice) [src: api:src/Leaderboard.cs:3]");
    expect(parsed.owner).toBe("alice");
    expect(parsed.malformed).toBe(false);
  });

  test("an item that names nobody is not a malformed one", () => {
    const parsed = itemOwner("- the counter is emitted [src: api:src/Leaderboard.cs:3]");
    expect(parsed.owner).toBeNull();
    expect(parsed.malformed).toBe(false);
  });

  test("`(owner: )` with no name is MALFORMED — a name was attempted and lost", () => {
    const parsed = itemOwner("- the counter is emitted (owner:   ) [src: api:src/Leaderboard.cs:3]");
    expect(parsed.owner).toBeNull();
    expect(parsed.malformed).toBe(true);
  });
});

describe("the schema is additive", () => {
  test("a card written before `owner:` existed still validates", () => {
    const front = {
      version: 1, id: "leaderboard", epic: "E1", title: "Player leaderboard",
      stories: ["S1"], repos: ["api"], status: "verified",
    };
    expect(validateWatcher(front).ok).toBe(true);
    expect(asWatcher(front).owner).toBeNull();
  });

  test("a card that declares one validates, and carries it", () => {
    const front = {
      version: 1, id: "leaderboard", epic: "E1", title: "Player leaderboard",
      stories: ["S1"], repos: ["api"], status: "verified", owner: "platform-oncall",
    };
    expect(validateWatcher(front).ok).toBe(true);
    expect(asWatcher(front).owner).toBe("platform-oncall");
  });

  test("an `owner:` that is not one line of text is refused, never coerced", () => {
    const base = {
      version: 1, id: "leaderboard", epic: "E1", title: "Player leaderboard",
      stories: ["S1"], repos: ["api"], status: "verified",
    };
    expect(validateWatcher({ ...base, owner: "" }).ok).toBe(false);
    expect(validateWatcher({ ...base, owner: ["alice"] }).ok).toBe(false);
  });
});

describe("declared beats derived, and the reader is told which", () => {
  test("an item's own `(owner: …)` wins, and the line says it was declared", () => {
    const text = card({
      signals: ["- `leaderboard.refreshed` fires (owner: alice) [src: api:src/Leaderboard.cs:3]"],
    });
    const { list } = checklist(text);
    const item = list.signals[0];
    expect(item?.declaredOwner).toBe("alice");
    expect(item?.ownerSource).toBe("item");
    expect(render(text)).toContain("owner: alice (declared on the item)");
  });

  test("the card's front matter is the fallback when the item names nobody", () => {
    const text = card({ owner: "platform-oncall" });
    const { list } = checklist(text);
    const item = list.signals[0];
    expect(item?.declaredOwner).toBe("platform-oncall");
    expect(item?.ownerSource).toBe("card");
    expect(render(text)).toContain("owner: platform-oncall (declared on the card)");
  });

  test("with nothing declared the repo-derived line is byte-identical to before", () => {
    const { list } = checklist(card());
    const item = list.signals[0];
    expect(item?.declaredOwner).toBeNull();
    expect(item?.ownerSource).toBe("repo");
    expect(item?.owners).toEqual(["api"]);
    expect(render(card())).toContain("owner: api\n");
    expect(render(card())).not.toContain("declared");
  });

  test("the item's text is never rewritten — the annotation stays in the words", () => {
    const { list } = checklist(card({
      signals: ["- `leaderboard.refreshed` fires (owner: alice) [src: api:src/Leaderboard.cs:3]"],
    }));
    expect(list.signals[0]?.text).toContain("(owner: alice)");
  });
});

describe("a name is never invented", () => {
  test("a malformed annotation is a SHAPE issue on the card, not a silent drop", () => {
    const { loaded } = checklist(card({
      signals: ["- `leaderboard.refreshed` fires (owner:) [src: api:src/Leaderboard.cs:3]"],
    }));
    const issue = loaded.card.issues.find((one) => one.message.includes("owner"));
    expect(issue).toBeDefined();
    expect(issue?.kind).toBe("shape");
  });
});

/**
 * Where the name COMES from.
 *
 * The framework already has one ledger of owners, and it is the one it deferred
 * to a person: `tldrx init` parks "Who owns `<repo>`?" as an `ownership` question
 * and the answer lands in `.tldrx/memory/facts.yml` (`init/questions.ts:152`).
 * The Watch stage was inlining `observability` and `deploy` facts and nothing
 * else, so a sub-agent asked for an owner had no honest source for one — and an
 * agent with no source invents. So the area is inlined, and the brief says the
 * name may only come from it.
 */
describe("the stage fills it from the ledger, or not at all", () => {
  const fact = (id: string, area: string, text: string): Fact => ({
    id, area, fact: text, repos: ["api"], kind: "answer", confidence: "stated",
    source: { who: "alan", when: "2026-09-01T00:00:00Z", run: null, q: "Q3" },
    supersedes: null, superseded_by: null, retired: null,
  });

  test("`ownership` is one of the areas a watcher prompt inlines", () => {
    expect([...WATCH_FACT_AREAS]).toContain("ownership");
  });

  test("an ownership fact reaches the sub-agent", () => {
    const rendered = renderWatchFacts([fact("F7", "ownership", "alice owns the api repo")], ["api"]);
    expect(rendered).toContain("alice owns the api repo");
  });

  test("the brief offers the annotation AND forbids inventing a name", () => {
    const feature: Feature = {
      id: "leaderboard", epicId: "E1", title: "Player leaderboard", repos: ["api"], stories: [],
      epic: null,
    };
    const brief = featureBrief(feature);
    expect(brief).toContain("(owner:");
    expect(brief.toLowerCase()).toContain("do not invent");
  });
});
