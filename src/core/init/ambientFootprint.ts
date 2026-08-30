/**
 * The only two files `tldrx init` touches outside `.tldrx/`: `.gitignore` and
 * `CLAUDE.md`.
 *
 * Concept §1: a ~10-line pointer is the framework's entire ambient footprint.
 * Both writes are marked blocks, so they are idempotent and a human can delete
 * the block without hunting for our lines.
 */
import { join } from "node:path";
import { GITIGNORE_MARKERS, MARKDOWN_MARKERS, upsertBlock } from "./markerBlock.ts";
import { runtime } from "../runtime/index.ts";
import type { WriteLog } from "./writeFile.ts";

/**
 * Re-includes first, then ignores.
 *
 * A project's own `.gitignore` is read BEFORE this block, and the last matching
 * pattern wins, so any rule the project already had can swallow tldrx state.
 * Measured 2026-08-30 on a real user's repo: the stock .NET `[Ll]og/` rule made
 * `git check-ignore` claim `tldrx-work/<run>/04-build/log/S1.md` — the build's
 * per-story review log, which spec §1 marks `[c]` committed — and the file was
 * written, never committed, and never missed.
 *
 * `!tldrx-work/**` and `!.tldrx/**` undo that for everything below the two state
 * roots. Both halves of each pair are needed: gitignore cannot re-include a file
 * whose PARENT DIRECTORY is excluded, so `**` (which matches the directories too)
 * is what lets git descend into `…/04-build/log/`, and the bare `!tldrx-work/`
 * covers a rule that ate the root itself (`*-work/`).
 */
export const GITIGNORE_NEGATIONS = [
  "!tldrx-work/",
  "!tldrx-work/**",
  "!.tldrx/",
  "!.tldrx/**",
] as const;

/** Gitignored paths from spec §1: machine-local or regenerated state. */
export const GITIGNORE_IGNORES = [
  ".tldrx/graphify-out/",
  ".tldrx/cache/",
  // Build-phase story worktrees: real checkouts of branches that ARE committed.
  // The trees themselves are machine-local scratch (spec §5, Build executor).
  ".tldrx/worktrees/",
  "tldrx-work/*/.lock",
  "tldrx-work/*/.agent/",
  // `tldrx install --claude` backs settings.json up before merging into it
  // (installClaude.ts). The backup is a full copy of a file that may hold local
  // env values, and it was the one thing the framework writes that nothing
  // ignored (2026-08-29 audit, §D).
  ".claude/settings.json.bak-tldrx-*",
] as const;

/**
 * The whole managed block. ORDER IS THE POINT: the negations come first and the
 * framework's own ignores after, because a later pattern beats an earlier one —
 * put `.tldrx/cache/` above `!.tldrx/**` and the cache stops being ignored.
 */
export const GITIGNORE_BODY = [
  "# tldrx state is committed (spec §1). These re-include it against a rule this",
  "# project already had — a stock `[Ll]og/`, a `docs/`, a `*.yml` — which would",
  "# otherwise swallow files like tldrx-work/<run>/04-build/log/<story>.md.",
  ...GITIGNORE_NEGATIONS,
  "",
  "# Machine-local or regenerated. These come AFTER the negations, so they win.",
  ...GITIGNORE_IGNORES,
].join("\n");

export const CLAUDE_POINTER_BODY = [
  "## tldrx",
  "",
  "This workspace runs the tldr-experts loop. The files are the state:",
  "",
  "- `.tldrx/workspace.yml` — repos, stack, and the ONLY commands that may be run",
  "- `.tldrx/map/` — the code map; every bullet cites a file",
  "- `.tldrx/memory/facts.yml` — answered questions; never re-ask what is in here",
  "- `tldrx-work/<run>/` — one folder per piece of work; `run.yml` is the resume point",
  "",
  "Run `tldrx --help`. Do not hand-edit `run.yml` or a computed `level:`.",
].join("\n");

export async function writeAmbientFootprint(outDir: string, log: WriteLog): Promise<void> {
  await upsertInto(join(outDir, ".gitignore"), ".gitignore", GITIGNORE_BODY, GITIGNORE_MARKERS, log);
  await upsertInto(join(outDir, "CLAUDE.md"), "CLAUDE.md", CLAUDE_POINTER_BODY, MARKDOWN_MARKERS, log);
}

async function upsertInto(
  absPath: string,
  relPath: string,
  body: string,
  markers: { begin: string; end: string },
  log: WriteLog,
): Promise<void> {
  const existing = (await runtime.exists(absPath)) ? await runtime.readText(absPath) : "";
  await log.overwrite(absPath, relPath, upsertBlock(existing, body, markers));
}
