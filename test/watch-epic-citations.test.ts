/**
 * gh #143 — the one artefact #140's annotation does not reach: a WATCHER CARD.
 *
 * #140 made a `file` citation that lives only on this run's unmerged epic ref
 * resolve — a `git cat-file blob <ref>:<path>` against every branch `run.yml`'s
 * `build.epic_branch` records — and NAMED the ref everywhere the checkers already
 * had a non-fatal channel: `claim-sources`' detail string and the auto gate's
 * note.
 *
 * `watcherFile.ts` had no such channel. It recorded an issue only when a
 * resolution was NOT `ok`, and any issue it recorded made the card fail, so
 * "true, and true only on `epic/…`" could not be said without failing a card
 * that is not wrong. Since `tldrx watch` and `watch arm` opt into the epic refs
 * (`toSrcContext(…, { epicRefs: true })`, `cli/commands/watch.ts`), such a
 * citation RESOLVED — in silence. A card committed to `main` could point a
 * reader at paths no merged ref has, which is the exact shape #140 exists to
 * stop, one artefact over.
 *
 * The channel is a separate, non-fatal `epicOnly` list on the card — the same
 * shape `handoff.ts` already carries for the same reason — read by every surface
 * that renders a card.
 *
 * The `git` here is real, as in `epic-citations.test.ts`: a stubbed one would let
 * the blob read be wrong in the same direction as the code under test.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkCard, loadCards, renderWatchList, watchListJson } from "../src/core/watch/watchViews.ts";
import { parseWatcherCard, unmergedRefsOf } from "../src/core/watch/watcherFile.ts";
import { watcherRelPath } from "../src/core/watch/index.ts";
import { clearSrcCaches } from "../src/core/text/index.ts";
import { loadWorkspace, toSrcContext } from "../src/hooks/lib/workspace.ts";
import { makeWorkspace, type TempWorkspace } from "./fixtures/tempWorkspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Real `git init` plus a `git cat-file` spawned by the code under test, so the
// budget is the load-aware one — a fixed number measures the box (#43).
setDefaultTimeout(spawnTestTimeout());

/** The branch the live run cut, spelled exactly as `run.yml` recorded it. */
const EPIC = "epic/money-and-payments";
/** A path that exists on that branch and on no merged ref. */
const EPIC_ONLY = "src/Modules/Payments/CreateChargeHandler.cs";

let ws: TempWorkspace | null = null;
afterEach(() => {
  ws?.dispose();
  ws = null;
  clearSrcCaches();
});

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", ["-c", "user.name=tldrx", "-c", "user.email=tldrx@example.com", ...args], {
    cwd, stdio: "ignore",
  });
}

function writeFile(dir: string, rel: string, text: string): void {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
}

/**
 * The fixture workspace with `api/` a real git repo holding an UNMERGED epic
 * branch and NO worktree on disk — the state `main` is always in, and the state a
 * fresh clone is always in.
 */
function withEpicBranch(options: { readonly merged?: boolean } = {}): TempWorkspace {
  const w = makeWorkspace();
  ws = w;
  const repo = join(w.root, "api");
  git(repo, ["init", "-b", "main", "-q"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "main: Hunt.cs"]);
  git(repo, ["checkout", "-q", "-b", EPIC]);
  writeFile(repo, EPIC_ONLY, `${Array.from({ length: 30 }, (_, i) => `// line ${String(i + 1)}`).join("\n")}\n`);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "epic: payments"]);
  git(repo, ["checkout", "-q", "main"]);
  if (options.merged === true) git(repo, ["merge", "-q", "--no-ff", "-m", "merge epic", EPIC]);
  appendFileSync(
    join(w.runDir, "run.yml"),
    `build: {epic_branch: ["${EPIC}"], branch_model: integration}\n`,
    "utf8",
  );
  return w;
}

/** The context `tldrx watch` builds (`cli/commands/watch.ts:195`) — epic refs ON. */
function ctxOf(w: TempWorkspace) {
  return toSrcContext(loadWorkspace(w.root), w.runDir, { epicRefs: true });
}

const ID = "payments";

/** One card whose four checked sections all cite `signalSrc`. */
function card(signalSrc: string): string {
  return [
    "---",
    "version: 1",
    `id: ${ID}`,
    "epic: E1",
    'title: "Customer payments"',
    "stories: [S2]",
    "repos: [api]",
    "status: verified",
    "---",
    "",
    `# ${ID}`,
    "",
    "## Signal",
    `- \`payment.captured\` is emitted [src: ${signalSrc}]`,
    "",
    "## Where",
    `- The api log stream [src: ${signalSrc}]`,
    "",
    "## Healthy baseline",
    `- 12-40 per hour [src: ${signalSrc}]`,
    "",
    "## Looks broken when",
    `- Zero for 30 minutes [src: ${signalSrc}]`,
    "",
    "## Query",
    "",
    "```kql",
    "traces | count",
    "```",
    "",
    "## Sources",
    "",
    "One emit site.",
    "",
  ].join("\n");
}

function writeCard(w: TempWorkspace, signalSrc: string): void {
  writeFile(w.runDir, watcherRelPath(ID), card(signalSrc));
}

describe("#143 — a watcher card citing a path only the unmerged epic has", () => {
  test("the card still validates — the citation is true, and refusing it would refuse the truth", () => {
    const w = withEpicBranch();
    writeCard(w, `api:${EPIC_ONLY}:28`);
    const parsed = parseWatcherCard(card(`api:${EPIC_ONLY}:28`), ctxOf(w), ID);

    expect(parsed.issues).toEqual([]);
    expect(parsed.ok).toBe(true);
    expect(parsed.decidedStatus).toBe("verified");
  });

  test("and the card NAMES the ref — the silence #140 closed everywhere else", () => {
    const w = withEpicBranch();
    const parsed = parseWatcherCard(card(`api:${EPIC_ONLY}:28`), ctxOf(w), ID);

    // One per checked section — four sections, four citations.
    expect(parsed.epicOnly).toHaveLength(4);
    expect(parsed.epicOnly.map((note) => note.src)).toEqual([EPIC, EPIC, EPIC, EPIC]);
    expect(parsed.epicOnly[0]?.path).toBe("Signal");
    // Non-fatal: it is not an issue, so it cannot make a card fail.
    expect(parsed.issues).toEqual([]);
    expect(parsed.ok).toBe(true);
    expect(unmergedRefsOf(parsed)).toEqual([EPIC]);
  });

  test("`watch check` says so beside the card's status instead of `every source resolves`", () => {
    const w = withEpicBranch();
    writeCard(w, `api:${EPIC_ONLY}:28`);
    const loaded = loadCards(w.runDir, ctxOf(w));
    const report = checkCard(loaded[0]!);

    expect(report.ok).toBe(true);
    const text = report.lines.join("\n");
    expect(text).toContain("on unmerged refs: 4");
    expect(text).toContain(EPIC);
    expect(text).toContain("unmerged");
  });

  test("`watch list` names the card and the branch a reader of `main` must look on", () => {
    const w = withEpicBranch();
    writeCard(w, `api:${EPIC_ONLY}:28`);
    const cards = loadCards(w.runDir, ctxOf(w));
    const table = renderWatchList("260828-leaderboard", cards);

    expect(table).toContain("on unmerged refs");
    expect(table).toContain(ID);
    expect(table).toContain(EPIC);
  });

  test("`watch list --json` carries the refs as data, not only as prose", () => {
    const w = withEpicBranch();
    writeCard(w, `api:${EPIC_ONLY}:28`);
    const cards = loadCards(w.runDir, ctxOf(w));
    const parsed = JSON.parse(watchListJson("260828-leaderboard", cards)) as {
      cards: { id: string; unmerged_refs: string[] }[];
      unmerged: number;
    };

    expect(parsed.cards[0]?.unmerged_refs).toEqual([EPIC]);
    expect(parsed.unmerged).toBe(1);
  });
});

describe("#143 — the three guards that say the annotation is not a rubber stamp", () => {
  test("a path on a MERGED ref gets no annotation at all", () => {
    const w = withEpicBranch({ merged: true });
    writeCard(w, `api:${EPIC_ONLY}:28`);
    const parsed = parseWatcherCard(card(`api:${EPIC_ONLY}:28`), ctxOf(w), ID);

    expect(parsed.ok).toBe(true);
    expect(parsed.epicOnly).toEqual([]);
    expect(checkCard(loadCards(w.runDir, ctxOf(w))[0]!).lines.join("\n")).not.toContain("unmerged");
    expect(renderWatchList("260828-leaderboard", loadCards(w.runDir, ctxOf(w)))).not.toContain("unmerged");
  });

  test("a citation that resolves NOWHERE is still a failing `source` issue", () => {
    const w = withEpicBranch();
    writeCard(w, "api:src/Modules/Payments/NoSuchFile.cs:1");
    const loaded = loadCards(w.runDir, ctxOf(w));

    expect(loaded[0]!.card.ok).toBe(false);
    expect(loaded[0]!.card.issues.some((i) => i.kind === "source")).toBe(true);
    expect(loaded[0]!.card.epicOnly).toEqual([]);
    expect(checkCard(loaded[0]!).ok).toBe(false);
  });

  test("with epic refs OFF — the context the hook builds — nothing resolves and nothing is annotated", () => {
    const w = withEpicBranch();
    const off = toSrcContext(loadWorkspace(w.root), w.runDir);
    const parsed = parseWatcherCard(card(`api:${EPIC_ONLY}:28`), off, ID);

    expect(parsed.ok).toBe(false);
    expect(parsed.epicOnly).toEqual([]);
  });
});
