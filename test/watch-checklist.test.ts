/**
 * `tldrx watch check` as a POST-MERGE checklist (gh #65).
 *
 * `tldrx ship` opens the PR carrying the handoff; the watcher card lists the
 * signals that would prove the feature works. Nothing connected the two, so
 * "merged ≠ shipped ≠ verified" stayed a human memory problem — a real one: the
 * owner's own CD gap once destroyed 19 records because a merged branch was read
 * as a deployed one.
 *
 * v1 is the manual command (owner decision, 2026-09-01): no `gh` detector, no
 * poller. It READS the run's cards and prints what a person has to go and look
 * at, with who owns each signal. It writes nothing.
 *
 * The three assertions that matter, and each is a refusal:
 *   - a card whose signal is `absent:` cannot be a checklist item, and the reader
 *     is told WHY, in the card's own words;
 *   - a query in someone else's console is printed, never offered as runnable;
 *   - a `$ … → exit n` signal is offered only when `workspace.yml` declares that
 *     exact command — the card marking it runnable is not enough on its own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SrcContext } from "../src/core/text/srcToken.ts";
import { clearSrcCaches } from "../src/core/text/srcToken.ts";
import {
  cardChecklist, loadCards, nothingToCheck, renderChecklist, WATCH_PHASE, watcherRelPath,
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

interface CardOptions {
  readonly status?: string;
  readonly signals?: readonly string[];
  readonly repos?: string;
}

function card(options: CardOptions = {}): string {
  const signals = options.signals ?? [
    "- `leaderboard.refreshed` is written on every refresh [src: api:src/Leaderboard.cs:3]",
  ];
  return [
    "---",
    "version: 1",
    "id: leaderboard",
    "epic: E1",
    'title: "Player leaderboard"',
    "stories: [S1]",
    `repos: ${options.repos ?? "[api]"}`,
    `status: ${options.status ?? "verified"}`,
    "---",
    "",
    "# leaderboard · Player leaderboard",
    "",
    "## Signal",
    ...signals,
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
    '| where message == "leaderboard.refreshed"',
    "```",
    "",
    "## Sources",
    "",
    "One emit site.",
    "",
  ].join("\n");
}

/** A run dir with one card on disk, plus the src context it is read against. */
function fixture(text: string, commands: readonly string[] = []): {
  readonly runDir: string;
  readonly ctx: SrcContext;
} {
  const root = mkdtempSync(join(tmpdir(), "tldrx-checklist-"));
  dirs.push(root);
  mkdirSync(join(root, "api", "src"), { recursive: true });
  writeFileSync(join(root, "api", "src", "Leaderboard.cs"), SOURCE, "utf8");
  const runDir = join(root, "tldrx-work", "260901-leaderboard");
  const cardPath = join(runDir, watcherRelPath("leaderboard"));
  mkdirSync(join(cardPath, ".."), { recursive: true });
  writeFileSync(cardPath, text, "utf8");
  return {
    runDir,
    ctx: { root, repos: new Map([["api", "api"]]), commands: new Set(commands), runDir },
  };
}

function render(text: string, commands: readonly string[] = []): string {
  const { runDir, ctx } = fixture(text, commands);
  const cards = loadCards(runDir, ctx);
  return renderChecklist("260901-leaderboard", cards.map((loaded) => cardChecklist(loaded, ctx)));
}

describe("the checklist is the card, made actionable", () => {
  test("every Signal item is a numbered checkbox, in the card's own words", () => {
    const out = render(card());
    expect(out).toContain("1. [ ]");
    expect(out).toContain("`leaderboard.refreshed` is written on every refresh");
  });

  test("the card's title, epic and status head its block", () => {
    const out = render(card());
    expect(out).toContain("leaderboard");
    expect(out).toContain("Player leaderboard");
    expect(out).toContain("E1");
    expect(out).toContain("verified");
  });

  /**
   * With nothing declared, the owner of a signal is the repo that emits it, and the
   * card's own `[src: <repo>:<path>:<line>]` names it. Derived, never invented.
   *
   * Since gh #70 a card MAY declare a human owner (an optional front-matter
   * `owner:`, or `(owner: …)` on the item) and this derivation is the fallback for
   * the cards that do not — which is every card in this file. `watch-owner.test.ts`
   * covers the declared side and asserts this line stays byte-identical.
   */
  test("each item names the repo that owns it, taken from its own citation", () => {
    expect(render(card())).toContain("api");
  });

  test("Where, Healthy baseline and Looks broken when are carried across", () => {
    const out = render(card());
    expect(out).toContain("Application Insights");
    expect(out).toContain("12-40 refreshes/hour");
    expect(out).toContain("Zero refreshes for 30 minutes");
  });

  test("the run id is on the page — a checklist for another run is worse than none", () => {
    expect(render(card())).toContain("260901-leaderboard");
  });
});

describe("a query is printed, never offered", () => {
  test("the Query block is reproduced with its language, and marked print-only", () => {
    const out = render(card());
    expect(out).toContain("kql");
    expect(out).toContain('| where message == "leaderboard.refreshed"');
    expect(out.toLowerCase()).toContain("print only");
  });

  test("nothing about the query claims tldrx can run it", () => {
    expect(render(card())).not.toContain("tldrx watch check --execute\n    traces");
  });
});

describe("a `$ … → exit n` signal is runnable only when the workspace declares it", () => {
  const CMD_SIGNAL = "- The health probe answers [src: $ npm run smoke → exit 0]";

  test("declared in workspace.yml — the item is offered, with the exit the card recorded", () => {
    const { runDir, ctx } = fixture(card({ signals: [CMD_SIGNAL] }), ["npm run smoke"]);
    const list = cardChecklist(loadCards(runDir, ctx)[0]!, ctx);
    expect(list.signals[0]?.runnable).toEqual({ command: "npm run smoke", expectExit: 0, repo: "api" });
    const out = renderChecklist("260901-leaderboard", [list]);
    expect(out).toContain("npm run smoke");
    expect(out).toContain("--execute");
  });

  test("NOT declared — print only, and the reason is named", () => {
    const { runDir, ctx } = fixture(card({ signals: [CMD_SIGNAL] }), []);
    const list = cardChecklist(loadCards(runDir, ctx)[0]!, ctx);
    expect(list.signals[0]?.runnable).toBeNull();
    expect(list.signals[0]?.printOnly ?? "").toContain("workspace.yml");
  });

  test("two repos and no repo on the bullet — print only rather than a guess", () => {
    const { runDir, ctx } = fixture(
      card({ signals: [CMD_SIGNAL], repos: "[api, lab]" }),
      ["npm run smoke"],
    );
    const list = cardChecklist(loadCards(runDir, ctx)[0]!, ctx);
    expect(list.signals[0]?.runnable).toBeNull();
    expect(list.signals[0]?.printOnly ?? "").toContain("repo");
  });

  test("a file-sourced signal is never runnable", () => {
    const { runDir, ctx } = fixture(card(), []);
    const list = cardChecklist(loadCards(runDir, ctx)[0]!, ctx);
    expect(list.signals[0]?.runnable).toBeNull();
    expect(list.signals[0]?.printOnly).toBeNull();
  });
});

describe("a draft card refuses, and says why in the card's own words", () => {
  const ABSENT = "- Nothing counts an empty refresh — instrument it [src: absent:api/src/Leaderboard.cs]";

  test("the absent source IS the reason, quoted", () => {
    const out = render(card({ status: "draft", signals: [ABSENT] }));
    expect(out).toContain("DRAFT");
    expect(out).toContain("absent:api/src/Leaderboard.cs");
  });

  test("an absent signal is not a checkbox — it is what to instrument", () => {
    const { runDir, ctx } = fixture(card({ status: "draft", signals: [ABSENT] }), []);
    const list = cardChecklist(loadCards(runDir, ctx)[0]!, ctx);
    expect(list.draftBecause).toEqual(["api/src/Leaderboard.cs"]);
    expect(list.signals[0]?.absent).toEqual(["api/src/Leaderboard.cs"]);
  });

  test("a card with one live and one absent signal keeps the live one checkable", () => {
    const { runDir, ctx } = fixture(
      card({
        status: "draft",
        signals: ["- `leaderboard.refreshed` is written [src: api:src/Leaderboard.cs:3]", ABSENT],
      }),
      [],
    );
    const list = cardChecklist(loadCards(runDir, ctx)[0]!, ctx);
    expect(list.signals).toHaveLength(2);
    expect(list.signals[0]?.absent).toEqual([]);
    expect(list.signals[1]?.absent).toEqual(["api/src/Leaderboard.cs"]);
    expect(list.draftBecause).toEqual(["api/src/Leaderboard.cs"]);
  });
});

describe("nothing to check is said, not implied", () => {
  test("no Watch stage at all names the phase that was never written", () => {
    const root = mkdtempSync(join(tmpdir(), "tldrx-checklist-"));
    dirs.push(root);
    const runDir = join(root, "tldrx-work", "260901-nowatch");
    mkdirSync(join(runDir, "03-plan"), { recursive: true });
    const message = nothingToCheck(runDir, "260901-nowatch", []) ?? "";
    expect(message).toContain(WATCH_PHASE);
    expect(message).toContain("260901-nowatch");
  });

  test("a Watch stage that wrote no card says THAT, which is a different problem", () => {
    const root = mkdtempSync(join(tmpdir(), "tldrx-checklist-"));
    dirs.push(root);
    const runDir = join(root, "tldrx-work", "260901-nocards");
    mkdirSync(join(runDir, WATCH_PHASE, "watchers"), { recursive: true });
    const message = nothingToCheck(runDir, "260901-nocards", []) ?? "";
    expect(message).toContain("no watcher card");
    expect(message).not.toContain("never");
  });

  test("with a card, there is nothing to refuse", () => {
    const { runDir, ctx } = fixture(card());
    expect(nothingToCheck(runDir, "260901-leaderboard", loadCards(runDir, ctx))).toBeNull();
  });
});
