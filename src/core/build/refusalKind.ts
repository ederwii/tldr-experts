/**
 * What KIND of line the permission layer refused, and what would have run (gh #278).
 *
 * Measured on two real headless runs in one day — six refusals, sonnet and opus
 * developers, with #271's "verbatim and alone" sentence in every prompt: every
 * refused line was either a shell CHAIN (`a && b`, `cmd; echo "EXIT:$?"`,
 * `cmd > log 2>&1`, `diff <(…) | head`) or a git VERB the developer does not
 * hold (`git checkout --`, `git status`, `git log`, `git merge-tree`,
 * `git rev-parse`). Each blocked the story after one attempt, a person reopened
 * it, and the same refusal came back — because the ledger recorded both causes
 * with one identical sentence and named no cure.
 *
 * A leaf: DATA in (the refused line), DATA out (a kind, and the sentence that
 * names the cure). The executor decides what to DO with the kind; the three
 * surfaces that write the refusal (`permissionBlockReason`, the review log, the
 * handoff) all append the same `refusalCure`, so they cannot drift.
 *
 * The shell reading is `hooks/lib/story.ts`'s — the same tokenizer `splitArgv`
 * runs every DoD command through — so a `;` inside quotes is an argument here
 * exactly as it is there. That is a reading of the LINE; whether the host's
 * permission layer reads quotes the same way is measured on the host (#215),
 * not asserted here, which is why a quoted separator classifies as `unknown`
 * and not as anything more confident.
 */
import { unquotedShellSeparator } from "../../hooks/lib/story.ts";
import { gitElsewhereOption, grantsCommand, isDeveloperGitVerb, slotForCommand } from "./developerGrants.ts";

export type RefusalKind =
  /**
   * The line chains commands: the named separator is the first bare one found.
   * `capturing` is #294's reading — the chain exists only to capture the exit
   * code or the output (`; echo "EXIT:$?"`, `> log 2>&1`), which is the shape
   * three consecutive refusals in one story had, and which earns a cure that
   * says why the capture is unnecessary instead of only what the rule is.
   */
  | { readonly kind: "separator"; readonly separator: string; readonly capturing: boolean }
  /** `git <verb>` alone, and `verb` is not in the developer's allowance. `equivalent` is the granted form, when one exists. */
  | { readonly kind: "verb"; readonly verb: string; readonly equivalent: string | null }
  /**
   * `git -C <path> …` (or `--git-dir` / `--work-tree`): a git line aimed at
   * ANOTHER tree (gh #287). Its own kind because its cure is its own: the verb
   * may well be granted — `git -C <worktree> log` was, measured on the field run
   * that killed a developer — and the thing to drop is the option, not the verb.
   */
  | { readonly kind: "elsewhere"; readonly option: string }
  /**
   * A non-git line no `commands:` slot grants (gh #285). Only reachable when the
   * caller PASSED the declared commands: without them, nobody knows whether the
   * line was grantable, and guessing would blame `workspace.yml` for a refusal it
   * had nothing to do with. `slot` is the value to add — see `slotForCommand`.
   */
  | { readonly kind: "undeclared"; readonly slot: string }
  /** Nothing about the line explains the refusal — a granted verb, a non-git command, an empty line. */
  | { readonly kind: "unknown" };

/**
 * How many times a `separator` refusal with no work is re-spawned with the cure
 * in front of the prompt, within the SAME attempt. ONE: a first refusal is a
 * habit the prompt did not beat; a second, with the cure as the prompt's first
 * line, is a turn that will not be reached this way, and a person gets it.
 * `verb` and `unknown` are never retried — a verb the allowance lacks will be
 * lacking again, and a cause nobody named cannot be cured by restating it.
 */
export const MAX_SEPARATOR_RETRIES = 1;

/**
 * `declared` is `.tldrx/workspace.yml`'s `commands:` AS THE DEVELOPER HELD THEM.
 * `undefined` — every caller before gh #285 — classifies exactly as it did then:
 * the `undeclared` kind is unreachable and a non-git line is `unknown`. An empty
 * but PRESENT set is not the same thing: it says the workspace grants nothing, so
 * the line really is undeclared.
 */
export function classifyRefusal(command: string, declared?: Iterable<string>): RefusalKind {
  const separator = unquotedShellSeparator(command);
  if (separator !== null) {
    return { kind: "separator", separator, capturing: capturesOutcome(command, separator) };
  }
  const argv = command.trim().split(/\s+/);
  if (argv[0] !== "git") return undeclaredKind(command, declared);
  const verb = argv[1] ?? "";
  // A `-C`-shaped option before the verb (`git -C <dir> log …`) is refused because
  // the grant is a PREFIX match on `git <verb>` and the second word is the option
  // — and, since #287, because it is MEANT to be: see `developerGrants.ts`. It has
  // a cure of its own, so it is classified rather than shrugged at.
  // A `git` line is NEVER blamed on `commands:`: the developer's git allowance is
  // `DEVELOPER_GIT_VERBS`, not a workspace slot, so "add a slot" would be a false
  // cure — and a false cure is worse than none (gh #285).
  const elsewhere = gitElsewhereOption(argv);
  if (elsewhere !== null) return { kind: "elsewhere", option: elsewhere };
  if (verb === "" || verb.startsWith("-")) return { kind: "unknown" };
  if (isDeveloperGitVerb(verb)) return { kind: "unknown" };
  return { kind: "verb", verb, equivalent: grantedEquivalent(verb, argv.slice(2)) };
}

/**
 * A line the workspace could grant and does not — or `unknown` when the caller
 * did not say what the workspace declares, or when the line is not an invocation
 * anything could be a slot for (an empty line, a bare `$(…)` the splitter left).
 */
function undeclaredKind(command: string, declared: Iterable<string> | undefined): RefusalKind {
  if (declared === undefined) return { kind: "unknown" };
  if (grantsCommand(declared, command)) return { kind: "unknown" };
  const slot = slotForCommand(command);
  return slot === "" ? { kind: "unknown" } : { kind: "undeclared", slot };
}

/**
 * The granted form of an ungranted verb, or null — never a guess.
 *
 * `checkout -- <path>` and `checkout <path>` put a file back: that is
 * `git restore <path>`. A branch switch (`-b`, `-B`, `--orphan`, `--track`) is
 * not, and nothing granted does it, so no equivalent is offered. `reset -- <path>`
 * and the `reset HEAD <path>` idiom unstage: that is `git restore --staged
 * <path>`. A mode reset (`--hard`, `--soft`, `--mixed`, `--merge`, `--keep`)
 * moves HEAD, which nothing granted does either.
 */
function grantedEquivalent(verb: string, args: readonly string[]): string | null {
  if (verb === "checkout") {
    const switching = args.some((a) => a === "-b" || a === "-B" || a === "--orphan" || a === "-t" || a === "--track");
    if (switching) return null;
    const hasTarget = args.some((a) => !a.startsWith("-")) || args.includes("--");
    return hasTarget ? "git restore <path>" : null;
  }
  if (verb === "reset") {
    const mode = args.some((a) => /^--(hard|soft|mixed|merge|keep)$/.test(a));
    if (mode) return null;
    if (args.includes("--")) return "git restore --staged <path>";
    const [first, second] = args.filter((a) => !a.startsWith("-"));
    if (first === "HEAD" && second !== undefined) return "git restore --staged <path>";
    return null;
  }
  return null;
}

/**
 * Does this line chain something on ONLY to capture the outcome? (gh #294)
 *
 * Measured: three consecutive developer attempts on one story, all refused, all
 * the same shape — `cmd > /tmp/s2_test.log 2>&1; echo "EXIT_STATUS_MARKER:$?"`,
 * then the same idiom after a reopen note saying "run each command alone", then
 * `cmd; echo "GATE_TEST_EXIT=$?"` after a note saying the facilitator captures
 * exit codes. #278's cure answered a question the developer was not asking: from
 * its side the `echo` was not a second command, it was HOW you read an exit code.
 * So when the tail is that idiom the cure says the thing that makes it
 * unnecessary, not only the rule it breaks.
 *
 * The reading is deliberately narrow — an `echo` mentioning `$?`, or a redirect
 * of the command's own output — because a cure that told a developer its `&&`
 * was "only capturing output" would be a false cure, which #285 established is
 * worse than none.
 */
const EXIT_CODE_ECHO_RE = /(^|[;&|])\s*echo\b[^;&|]*\$\?/;

export function capturesOutcome(command: string, separator: string): boolean {
  if (EXIT_CODE_ECHO_RE.test(command)) return true;
  return separator === ">" || separator === ">>" || separator === "2>&1";
}

/**
 * The WHY behind "don't append `echo $?`" — one clause, factual, no scolding.
 *
 * It says ONLY what this repo can show, and only what holds for EVERY provider:
 * the facilitator re-runs each Definition of Done command after the developer and
 * writes its exit code (`build/dodRunner.ts` — `exitCode` into the measured row
 * at :144 for the base run and :302 for the story's, both from `runDodCommand`).
 * That is a fact about the facilitator, so it is equally true whichever agent was
 * spawned.
 *
 * What it deliberately does NOT say: that the agent's own execution tool hands the
 * exit code back. Measured for Claude Code's `Bash` tool in a maintainer session —
 * a non-zero command returns `Exit code <n>` with the output — and NOT established
 * anywhere for `codex exec`: nothing in `facilitator/spawnAgent.ts`,
 * `CONTRIBUTING.md` or `test/model-provider.test.ts` pins what that CLI's exec tool
 * returns to the model. This sentence goes into the SHARED developer prompt, which
 * both providers read, so asserting it there would tell a Codex developer something
 * we have not measured — the precise failure (#294) this cure exists to stop, one
 * level up: a plausible explanation is worse than none, because it is believed and
 * acted on. If the Codex behaviour is ever measured, it can be added — with the
 * measurement beside it.
 */
export const OUTCOME_ALREADY_REPORTED =
  "the facilitator re-runs the Definition of Done after you and records each command's exit "
  + "code, so the number the `echo` would print is measured and written down whether you "
  + "capture it or not";

/**
 * The sentence appended to #261's recorded reason, or "" for `unknown` — which
 * keeps that reason byte-identical to what #261 shipped.
 */
export function refusalCure(kind: RefusalKind): string {
  switch (kind.kind) {
    case "separator":
      return "run each command alone — shell separators split a line into subcommands that each need their own grant"
        + (kind.capturing ? `. The exit code is not lost by dropping it: ${OUTCOME_ALREADY_REPORTED}` : "");
    case "elsewhere":
      return `drop \`${kind.option} <path>\` and run git from your own worktree — \`${kind.option}\` `
        + "points git at another directory, so it is refused on purpose rather than missing from the "
        + "allowance: it would reach trees this story does not own. Your working directory already is "
        + "the worktree, and the read verbs run there";
    case "verb":
      return kind.equivalent === null
        ? `\`git ${kind.verb}\` is not granted`
        : `\`git ${kind.verb}\` is not granted; use \`${kind.equivalent}\``;
    case "undeclared":
      return `nothing in .tldrx/workspace.yml's \`commands:\` grants \`${kind.slot}\` — a developer's `
        + "grant is built from the declared commands, so no re-run and no reopen note can make this "
        + `line runnable. The operator's cure: add a \`commands:\` slot whose value is exactly `
        + `\`${kind.slot}\` (a slot grants that string plus any arguments), or a longer prefix of the `
        + "refused line if less should be granted";
    case "unknown":
      return "";
  }
}

/**
 * #261's sentence plus the cure, when there is one to name. The ONE joiner.
 *
 * `declared` (gh #285) is the workspace's `commands:` as the refused developer
 * held them; omitted, every sentence is byte-identical to what #278 shipped.
 */
export function withCure(sentence: string, command: string, declared?: Iterable<string>): string {
  const cure = refusalCure(classifyRefusal(command, declared));
  return cure === "" ? sentence : `${sentence}. The cure: ${cure}`;
}

/**
 * The lines put IN FRONT of the developer prompt on the one retry: the refused
 * line named, the mechanism, the rule. First, because the six field refusals
 * happened with the same rule lower down in `## Rules` and it was not read.
 */
export function separatorCurePrefix(command: string): string {
  const separator = unquotedShellSeparator(command);
  // gh #294: the retry that kept failing re-added the `echo` because the cure
  // never said the number was already coming back. Where the chain is only a
  // capture, the prefix says so — one clause, in front, with the rule.
  const capturing = separator !== null && capturesOutcome(command, separator);
  return [
    `Your previous command \`${command}\` was refused because it chains commands. Run each command alone.`,
    "The permission layer splits a line at every shell separator (`&&`, `;`, `|`, `>`, `2>&1`, `$()`)",
    "and each fragment must match its own grant, so a compound line is refused even when every",
    "command in it is allowed on its own. This is the one retry: a second refusal blocks the story.",
    ...(capturing
      ? [`The exit code is not lost by dropping it: ${OUTCOME_ALREADY_REPORTED}.`]
      : []),
    "",
  ].join("\n");
}
