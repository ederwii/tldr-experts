/** Copy the mini workspace fixture somewhere writable; hooks mutate what they read. */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../../src/core/paths.ts";

export const FIXTURE_WORKSPACE = join(FRAMEWORK_ROOT, "test", "fixtures", "workspace");
export const FIXTURE_RUN = "260828-leaderboard";

export interface TempWorkspace {
  readonly root: string;
  readonly runDir: string;
  readonly dispose: () => void;
}

export function makeWorkspace(): TempWorkspace {
  const root = mkdtempSync(join(tmpdir(), "tldrx-fixture-"));
  cpSync(FIXTURE_WORKSPACE, root, { recursive: true });
  return {
    root,
    runDir: join(root, "tldrx-work", FIXTURE_RUN),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
