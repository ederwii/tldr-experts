/**
 * Copy the views fixture somewhere writable.
 *
 * `retro` writes retro.md, `retro --apply` appends to practices.md and
 * `dashboard --static` writes index.html, so every test that runs one of those
 * works on a throwaway copy — the fixture in the repo stays byte-identical.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../../../src/core/paths.ts";

export const VIEWS_FIXTURE = join(FRAMEWORK_ROOT, "test", "fixtures", "views", "workspace");
export const VIEWS_RUN = "260901-scoreboard";
/** A `now` the fixture's evidence dates are meaningful relative to. */
export const VIEWS_NOW = new Date("2026-09-01T12:00:00Z");

export interface TempViews {
  readonly root: string;
  readonly runDir: string;
  readonly dispose: () => void;
}

export function makeViewsWorkspace(): TempViews {
  const root = mkdtempSync(join(tmpdir(), "tldrx-views-"));
  cpSync(VIEWS_FIXTURE, root, { recursive: true });
  return {
    root,
    runDir: join(root, "tldrx-work", VIEWS_RUN),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
