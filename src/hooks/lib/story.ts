/**
 * The three things the DoD gate reads out of `tldrx-work/<run>/03-plan/stories/<id>.md`.
 *
 * Story/epic file schemas are an open decision (spec §7), so this reads the two
 * fields the gate is specified against — `status:` and `repo:` — and the fenced
 * ```dod block, by line scanning rather than by assuming a frontmatter format.
 */

import { runtime } from "../../core/runtime/index.ts";

export interface StoryFacts {
  readonly setsDone: boolean;
  readonly repo: string | null;
  readonly dodCommands: readonly string[];
  readonly hasDodBlock: boolean;
  readonly timeoutS: number | null;
}

const DONE_RE = /^\s*(?:[-*]\s*)?(?:\*\*)?status(?:\*\*)?\s*:\s*["'`]?done["'`]?\.?\s*$/i;
const REPO_RE = /^\s*(?:[-*]\s*)?(?:\*\*)?repo(?:\*\*)?\s*:\s*["'`]?([A-Za-z0-9._-]{1,64})["'`]?\s*$/i;
const TIMEOUT_RE = /^\s*(?:[-*]\s*)?(?:\*\*)?timeout_s(?:\*\*)?\s*:\s*(\d{1,6})\s*$/i;
const FENCE_OPEN_RE = /^\s*```+\s*dod\s*$/i;
const FENCE_CLOSE_RE = /^\s*```+\s*$/;

export function readStory(text: string): StoryFacts {
  const lines = text.split("\n");
  let setsDone = false;
  let repo: string | null = null;
  let timeoutS: number | null = null;
  let hasDodBlock = false;
  const dodCommands: string[] = [];
  let inDod = false;

  for (const line of lines) {
    if (inDod) {
      if (FENCE_CLOSE_RE.test(line)) {
        inDod = false;
        continue;
      }
      const command = line.trim();
      if (command !== "" && !command.startsWith("#")) dodCommands.push(command);
      continue;
    }
    if (FENCE_OPEN_RE.test(line)) {
      inDod = true;
      hasDodBlock = true;
      continue;
    }
    if (!setsDone && DONE_RE.test(line)) setsDone = true;
    if (repo === null) {
      const m = REPO_RE.exec(line);
      if (m?.[1] !== undefined) repo = m[1];
    }
    if (timeoutS === null) {
      const m = TIMEOUT_RE.exec(line);
      if (m?.[1] !== undefined) timeoutS = Number(m[1]);
    }
  }
  return { setsDone, repo, dodCommands, hasDodBlock, timeoutS };
}

export interface CommandResult {
  readonly command: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly tail: string;
}

/**
 * Run one DoD command from `cwd`.
 * `[assumption]` — commands run through `sh -c`, because a team's DoD is written
 * the way they type it (`npm run test`), and the spec constrains only the commands
 * a *stage file* may cite, not a story's dod block.
 */
export async function runDodCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  const { exitCode, stdout, stderr, timedOut } = await runtime.spawn("/bin/sh", ["-c", command], {
    cwd,
    timeoutMs,
  });
  return { command, exitCode, timedOut, tail: lastMeaningfulLine(`${stdout}\n${stderr}`) };
}

/** The last non-empty line of the combined output, capped so a deny stays readable. */
export function lastMeaningfulLine(output: string, max = 200): string {
  const lines = output.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1] ?? "";
  return last.length > max ? `${last.slice(0, max - 1)}…` : last;
}
