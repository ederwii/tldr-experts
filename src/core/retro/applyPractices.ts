/**
 * `tldrx retro --apply` — append the practice proposals to
 * `.tldrx/memory/practices.md` under a dated, run-stamped heading.
 *
 * Append-only and idempotent: the run id is in the heading, so a second `--apply`
 * for the same run finds its own heading and does nothing. Without `--apply`
 * nothing outside `retro.md` is touched at all — a retro that silently edited
 * team memory would make the command unrunnable out of curiosity.
 *
 * `[assumption]` The date in the heading is today's, and idempotency keys on the
 * run id rather than the date — re-applying a run a week later must still not
 * duplicate its block.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { renderProposal, type Proposal } from "./Proposal.ts";

export const PRACTICES_FILE = "practices.md";

const HEADER = [
  "# Practices",
  "",
  "How this team works, learned from runs. Appended by `tldrx retro --apply`;",
  "every bullet cites the events line that produced it.",
  "",
].join("\n");

export function practicesPath(root: string): string {
  return join(root, PROJECT_FRAMEWORK_DIR, "memory", PRACTICES_FILE);
}

export interface ApplyResult {
  readonly path: string;
  readonly appended: boolean;
  /** Why nothing was appended, when `appended` is false. */
  readonly reason: string | null;
}

export function applyPractices(
  root: string,
  run: string,
  proposals: readonly Proposal[],
  now: Date = new Date(),
): ApplyResult {
  const path = practicesPath(root);
  if (proposals.length === 0) {
    return { path, appended: false, reason: "there are no practice proposals to apply" };
  }

  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const stamp = `— run ${run}`;
  if (existing.includes(stamp)) {
    return { path, appended: false, reason: `practices.md already carries a block for run ${run}` };
  }

  const heading = `## ${isoDate(now)} ${stamp}`;
  const block = [heading, "", ...proposals.map((proposal) => renderProposal(run, proposal)), ""].join("\n");
  const base = existing === "" ? HEADER : existing.endsWith("\n") ? existing : `${existing}\n`;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${base}\n${block}`, "utf8");
  return { path, appended: true, reason: null };
}

function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}
