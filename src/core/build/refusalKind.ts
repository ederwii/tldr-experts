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
import { isDeveloperGitVerb } from "./developerGrants.ts";

export type RefusalKind =
  /** The line chains commands: the named separator is the first bare one found. */
  | { readonly kind: "separator"; readonly separator: string }
  /** `git <verb>` alone, and `verb` is not in the developer's allowance. `equivalent` is the granted form, when one exists. */
  | { readonly kind: "verb"; readonly verb: string; readonly equivalent: string | null }
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

export function classifyRefusal(command: string): RefusalKind {
  const separator = unquotedShellSeparator(command);
  if (separator !== null) return { kind: "separator", separator };
  const argv = command.trim().split(/\s+/);
  if (argv[0] !== "git") return { kind: "unknown" };
  const verb = argv[1] ?? "";
  // A global option before the verb (`git -C <dir> rm …`) is refused because the
  // grant is a PREFIX match on `git <verb>` and the second word is `-C`, which
  // is neither a verb this list knows nor one it can name a cure for.
  if (verb === "" || verb.startsWith("-")) return { kind: "unknown" };
  if (isDeveloperGitVerb(verb)) return { kind: "unknown" };
  return { kind: "verb", verb, equivalent: grantedEquivalent(verb, argv.slice(2)) };
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
 * The sentence appended to #261's recorded reason, or "" for `unknown` — which
 * keeps that reason byte-identical to what #261 shipped.
 */
export function refusalCure(kind: RefusalKind): string {
  switch (kind.kind) {
    case "separator":
      return "run each command alone — shell separators split a line into subcommands that each need their own grant";
    case "verb":
      return kind.equivalent === null
        ? `\`git ${kind.verb}\` is not granted`
        : `\`git ${kind.verb}\` is not granted; use \`${kind.equivalent}\``;
    case "unknown":
      return "";
  }
}

/** #261's sentence plus the cure, when there is one to name. The ONE joiner. */
export function withCure(sentence: string, command: string): string {
  const cure = refusalCure(classifyRefusal(command));
  return cure === "" ? sentence : `${sentence}. The cure: ${cure}`;
}

/**
 * The lines put IN FRONT of the developer prompt on the one retry: the refused
 * line named, the mechanism, the rule. First, because the six field refusals
 * happened with the same rule lower down in `## Rules` and it was not read.
 */
export function separatorCurePrefix(command: string): string {
  return [
    `Your previous command \`${command}\` was refused because it chains commands. Run each command alone.`,
    "The permission layer splits a line at every shell separator (`&&`, `;`, `|`, `>`, `2>&1`, `$()`)",
    "and each fragment must match its own grant, so a compound line is refused even when every",
    "command in it is allowed on its own. This is the one retry: a second refusal blocks the story.",
    "",
  ].join("\n");
}
