/**
 * Copy the views fixture somewhere writable.
 *
 * `retro` writes retro.md, `retro --apply` appends to practices.md and
 * `dashboard --static` writes index.html, so every test that runs one of those
 * works on a throwaway copy — the fixture in the repo stays byte-identical.
 *
 * **The clock is part of the fixture.** The evidence rows in
 * every `competencies.yml` under `.tldrx/experts` are dated ABSOLUTELY, and the
 * level formula
 * weighs every row by how old it is, so a copy that keeps those dates means
 * something different every real day. An in-process test hands the reader
 * `VIEWS_NOW` and is hermetic; a test that spawns the CLI cannot — the CLI reads
 * `new Date()` — and one of them (#240) went red on `main` at the exact sha of a
 * published release, with no commit in between, the day the fixture's ef-core
 * rows decayed past the level-3 threshold. So a CLI test asks for a copy anchored
 * to the clock its assertion will be evaluated against — `makeViewsWorkspace({ now })`
 * — and every row keeps the AGE the fixture meant rather than the date it was
 * written with. Anything that reads the copy with `VIEWS_NOW` keeps the default.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../../../src/core/paths.ts";

export const VIEWS_FIXTURE = join(FRAMEWORK_ROOT, "test", "fixtures", "views", "workspace");
export const VIEWS_RUN = "260901-scoreboard";
/** A `now` the fixture's evidence dates are meaningful relative to. */
export const VIEWS_NOW = new Date("2026-09-01T12:00:00Z");

const DAY_MS = 86_400_000;

export interface TempViews {
  readonly root: string;
  readonly runDir: string;
  readonly dispose: () => void;
}

export interface ViewsOptions {
  /**
   * Re-date the copied evidence rows so each keeps its age relative to THIS
   * instant instead of to `VIEWS_NOW`. Pass the clock the assertion is evaluated
   * against — `new Date()` for anything that spawns the CLI.
   */
  readonly now?: Date;
}

export function makeViewsWorkspace(options: ViewsOptions = {}): TempViews {
  const root = mkdtempSync(join(tmpdir(), "tldrx-views-"));
  cpSync(VIEWS_FIXTURE, root, { recursive: true });
  if (options.now !== undefined) reanchorEvidence(root, options.now);
  return {
    root,
    runDir: join(root, "tldrx-work", VIEWS_RUN),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Shift every evidence `at:` in the COPY by whole days, so the gap between each
 * row and `now` is the gap the fixture author wrote against `VIEWS_NOW`. Whole
 * days because the rows are dates, not timestamps; `last_trained:` is a timestamp
 * and is deliberately left alone — no level reads it.
 */
function reanchorEvidence(root: string, now: Date): void {
  const shiftMs = Math.round((now.getTime() - VIEWS_NOW.getTime()) / DAY_MS) * DAY_MS;
  if (shiftMs === 0) return;
  const experts = join(root, ".tldrx", "experts");
  if (!existsSync(experts)) return;
  for (const name of readdirSync(experts)) {
    const path = join(experts, name, "competencies.yml");
    if (!existsSync(path)) continue;
    const shifted = readFileSync(path, "utf8").replace(
      /(\bat: )(\d{4}-\d{2}-\d{2})(?![\d\-T])/g,
      (_match, key: string, date: string) =>
        `${key}${new Date(Date.parse(`${date}T00:00:00Z`) + shiftMs).toISOString().slice(0, 10)}`,
    );
    writeFileSync(path, shifted);
  }
}
