/**
 * One rule, one implementation: **a command a data file names must be byte-equal
 * to a command `.tldrx/workspace.yml` declares.**
 *
 * Three data files want to run a shell command — a story's ```dod block (§2.13),
 * a stage's `cmd` check (§2.3) and, since design §F.1, a stage's `preconditions:`
 * — and all three are DATA. Data does not get to invent a command that will be
 * run as the user. Before this module each site spelled the rule for itself:
 * `validateStoryDod` in `story.ts`, `checkCommand` in `run/checks.ts`. Two
 * spellings of one rule is how a third site gets a third, weaker one, so the
 * comparison and both refusal sentences live here and the sites call them.
 *
 * The comparison is `Set.has` on the raw string. Not normalised, not trimmed, not
 * shell-parsed: `docker info && rm -rf ~` is refused because it is not in the set,
 * and the moment the check started being clever about what a command "means" is
 * the moment it could be argued around.
 */

/**
 * The refusal when the workspace declares NO commands at all.
 *
 * The 2026-08-29 audit measured what the old "an empty allowlist means skip the
 * rule" assumption cost: `dod-gate` runs each command through `/bin/sh -c` as the
 * user, so in a workspace with no `commands:` a story saying `dod: rm -rf ~` was
 * legal at plan time and executed at done time. An empty allowlist REFUSES.
 *
 * The wording is subject-neutral ("these commands") because a stage precondition
 * now reaches it too; every substring the dod tests assert is unchanged.
 */
export function noAllowlistMessage(command: string): string {
  return `\`${command}\` cannot be allowed: .tldrx/workspace.yml declares no commands, so there is `
    + "nothing to check it against. Add the command under the repo's `commands:` — these commands are "
    + "run for real, as you, and an empty allowlist is not a permit.";
}

/**
 * The command that repairs the drift this refusal is usually reporting.
 *
 * A story's dod block must name workspace commands VERBATIM, so editing
 * `workspace.yml` orphans every approved story that cited the old string.
 * Measured live on `260829-scoring-leaderboard` (2026-08-31): one edit —
 * a filtered `test:`, `lint:` removed — invalidated the dod blocks of 8 approved
 * stories at once, and the only recoveries on offer were hand-editing
 * agent-approved artefacts or re-running the whole Plan stage for two lines.
 */
export const SYNC_DOD_COMMAND = "tldrx plan sync-dod";

/**
 * The refusal when the workspace declares commands and this is not one of them.
 *
 * A STORY gets the remedy appended, because a story's dod block is data the
 * operator did not type and cannot be asked to retype: the constraint alone
 * states the rule and stops, which is the failure mode this repo keeps finding
 * (see #35). A STAGE does not — its `cmd:` is a line a human wrote in
 * `stage.yml`, and `sync-dod` does not touch stage files.
 */
export function notDeclaredMessage(command: string, subject: string): string {
  const rule = `\`${command}\` is not one of .tldrx/workspace.yml's commands — a ${subject} may not invent one`;
  return subject === "story"
    ? `${rule}. If workspace.yml was edited after the plan was approved, `
      + `\`${SYNC_DOD_COMMAND}\` rewrites the story's dod block to the current commands.`
    : rule;
}

/**
 * The whole rule, once. `null` ⇒ the command is allowed; a string ⇒ the refusal,
 * already worded for `subject` ("story", "stage").
 */
export function allowlistIssue(
  command: string,
  allowed: ReadonlySet<string>,
  subject: string,
): string | null {
  if (allowed.size === 0) return noAllowlistMessage(command);
  return allowed.has(command) ? null : notDeclaredMessage(command, subject);
}

/**
 * The one `commands:` slot a Definition of Done may NOT name (2026-09-07).
 *
 * A story's ```dod block must be byte-equal to a declared command, and the developer
 * prompt hands the sub-agent the same list with "these are the only ones you may run".
 * On three real workspaces that made the whole suite the developer's only instrument —
 * one of them 11,929 tests across 855 files, run 6–10 times per story while iterating,
 * on top of the 2–3 runs the Definition of Done itself pays for.
 *
 * `test_fast` is the second speed: declared, therefore runnable, and deliberately NOT
 * evidence. Done means the declared suite exited 0, so a dod block naming the fast
 * subset would quietly lower the bar the whole framework rests on. The refusal below
 * is what stops it, and it names the slot: the generic "not one of workspace.yml's
 * commands" would be a false sentence about a command the file plainly declares.
 */
export const ITERATION_ONLY_SLOT = "test_fast";

/** The refusal when a dod line names the repo's `test_fast` command. */
export function iterationOnlyDodMessage(command: string): string {
  return `\`${command}\` is this repo's \`${ITERATION_ONLY_SLOT}\` command, and a Definition of Done `
    + `may not name it: \`${ITERATION_ONLY_SLOT}\` is the fast subset the developer ITERATES on, not `
    + "the suite that proves the story. Name the repo's `test` command instead — the gate re-runs "
    + "what the dod block names, after the developer has stopped.";
}

/**
 * The `<slot>_scoped` suffix — a TEMPLATE beside a declared slot, never a command
 * (#257, measured 2026-09-12).
 *
 * One 8-story epic put 99 `check.*` events on its ledger: every story's Definition
 * of Done ran the whole declared list — the full suite among it — on every attempt
 * and every fix round, and the epic head that actually ships was never run at all.
 * The DoD is a DELTA gate ("this story did not break the tree"), proven until now
 * by running everything because nothing narrower existed.
 *
 * `commands.test_scoped: "pytest {{paths}}"` is the narrower thing. It shadows
 * `test:` for a story's OWN check — `{{paths}}` becomes the story's changed paths,
 * substituted at the argv level — and the full `test:` then runs once per epic, on
 * the epic head, before the gate. The template is deliberately NOT in the
 * allowlist: it is not citable, the developer is never handed it, and a ```dod
 * line naming it is refused at Plan time with a sentence naming the slot — the
 * story's dod names the FULL command, and the runner decides the scope.
 */
export const SCOPED_SUFFIX = "_scoped";

/** The one token a scoped template must carry, as a whole word, exactly once. */
export const PATHS_PLACEHOLDER = "{{paths}}";

/** `test_scoped` → `test`; null for any key that is not a scoped slot. */
export function scopedSlotOf(slot: string): string | null {
  if (!slot.endsWith(SCOPED_SUFFIX)) return null;
  const base = slot.slice(0, -SCOPED_SUFFIX.length);
  return base === "" ? null : base;
}

/**
 * Whether a template is usable: `{{paths}}` present as a whole word, once.
 * `x{{paths}}` is one token to argv splitting and cannot be substituted; two
 * tokens would run the paths twice.
 */
export function isScopedTemplate(value: string): boolean {
  const words = value.split(/\s+/).filter((w) => w !== "");
  return words.filter((w) => w === PATHS_PLACEHOLDER).length === 1
    && !words.some((w) => w !== PATHS_PLACEHOLDER && w.includes(PATHS_PLACEHOLDER));
}

/** The refusal when a dod line names a repo's `<slot>_scoped` template. */
export function scopedOnlyDodMessage(command: string): string {
  return `\`${command}\` is one of this repo's \`${SCOPED_SUFFIX}\` templates, and a Definition of Done `
    + `may not name it: a \`<slot>${SCOPED_SUFFIX}\` entry is how the gate narrows the FULL command to the `
    + "story's own paths, not a command of its own. Name the repo's full command instead — the gate "
    + "substitutes the template itself, and runs the full command once on the epic head.";
}

/**
 * Whether `command` is a MUTATING GENERATOR — a command that writes new files or
 * state as a side effect of running it (a migration-add, a scaffold, an
 * un-verified format) — rather than a pure verification command (build/test/lint)
 * (gh #362).
 *
 * Measured live, tldrx 0.31.1: a `.NET` story's ```dod block declared, among
 * ordinary `dotnet build`/`dotnet test` lines, `dotnet ef migrations add …`. The
 * base-tree pre-flight (`dodRunner.ts`'s `measureBaseCommand`) ran it against the
 * UNTOUCHED base tree as a routine MEASUREMENT and wrote a migration triple into
 * pristine main as a side effect of asking a question — it only failed to reach
 * `main` because `dotnet-ef` was not yet restored in that environment.
 *
 * A generator is unsafe wherever a dod command is expected to be RE-RUNNABLE:
 * the base pre-flight measures it against the untouched tree before any story
 * exists, and `dod-gate` re-runs every dod command again when a story claims
 * `status: done` (spec §2.13) — a generator run a second time either collides
 * with what its first run already wrote or silently duplicates it, so neither
 * re-run means what a dod re-run is supposed to mean. Unlike `tool_restore:` or
 * `test_fast` (above), there is no RESERVED SLOT KEY a generator lives under — a
 * team names its migration-add slot whatever it likes — so detection is BY NAME,
 * the issue's own wording: the command TEXT, not the `commands:` key it is
 * declared under.
 *
 * Two doors read this one derivation (§7): `validateStoryDod` (`story.ts`)
 * refuses it at Plan time, so the plan is never written this way, and
 * `measureBaseCommand` (`dodRunner.ts`) refuses to RUN one against either base
 * tree it measures, as defense in depth for a story file that reached Build
 * some other way (hand-edited, or written before this rule existed). Neither
 * door touches a story's own fresh worktree: that is where a generator is
 * legitimately RUN, once, by the developer — this rule is about re-running it as
 * a MEASUREMENT, not about whether it may run at all.
 *
 * Conservative by design: false negatives (a generator this misses) cost what
 * they always cost; false positives would refuse an ordinary build/test command
 * that happens to share a word, which is why every pattern below matches a whole
 * ARGV TOKEN (or an adjacent pair of them), never a substring — `npm run
 * format:check` does not contain the token `format`, so it is untouched.
 */
const GENERATOR_TOKEN_PAIRS: readonly (readonly [string, readonly string[]])[] = [
  // `dotnet ef migrations add`, `prisma migrate dev`-shaped, a generic ORM
  // CLI's "migrations|migration|migrate add|new|create|dev": every one of
  // these WRITES a new migration file rather than applying existing ones —
  // `migrate deploy`/`migrations remove`/`migrate status` are a DIFFERENT
  // pair and untouched.
  ["migrations", ["add", "new", "create"]],
  ["migration", ["add", "new", "create"]],
  ["migrate", ["add", "new", "create", "dev"]],
];

function generatorTokenPairMatch(argv: readonly string[]): boolean {
  for (let i = 0; i + 1 < argv.length; i++) {
    const head = (argv[i] ?? "").toLowerCase();
    const tail = (argv[i + 1] ?? "").toLowerCase();
    for (const [first, seconds] of GENERATOR_TOKEN_PAIRS) {
      if (head === first && seconds.includes(tail)) return true;
    }
  }
  return false;
}

/**
 * A flag that turns a formatter's rewrite into a pure check — no generator
 * either spells it out.
 *
 * `--verify`/`--verify-no-changes` (`dotnet format`) was the issue's own
 * example; review on gh #362 measured (`bun -e`) that the set was too narrow —
 * `--check` is the STANDARD idempotent verify flag for prettier, black,
 * rustfmt and gofmt, so `npm run format -- --check` (an ordinary, common dod
 * line) was refused as a generator, a new stall class the issue never
 * intended. `--dry-run`/`--diff` are the same shape from other formatters
 * (gofmt, terraform fmt).
 */
const VERIFY_ONLY_FLAG_RE = /^--(verify(-no-changes)?|check|dry-run|diff)$/i;

export function isGeneratorCommand(command: string): boolean {
  const argv = command.trim().split(/\s+/).filter((token) => token !== "");
  if (generatorTokenPairMatch(argv)) return true;
  // A bare `scaffold` verb, anywhere as its own token: `dotnet scaffold`, `rails
  // generate scaffold …`, `nest generate --type scaffold` all write files.
  if (argv.some((token) => token.toLowerCase() === "scaffold")) return true;
  // A `format` token with NO verify-only flag rewrites files in place; the SAME
  // command WITH `--verify`/`--verify-no-changes` only checks, and is a pure
  // verification command like any other.
  if (
    argv.some((token) => token.toLowerCase() === "format")
    && !argv.some((token) => VERIFY_ONLY_FLAG_RE.test(token))
  ) {
    return true;
  }
  return false;
}

/** The refusal when a dod line names a mutating generator command (gh #362). */
export function generatorDodMessage(command: string): string {
  return `\`${command}\` looks like a GENERATOR — a command that writes new files or state as a side `
    + "effect of running it (a migration-add, a scaffold, an un-verified format) — and a Definition of "
    + "Done may not name it: the base-tree pre-flight measures every dod command against the untouched "
    + "base tree before any story is dispatched, and `dod-gate` re-runs it again when the story claims "
    + "`status: done` — running a generator twice either collides with what it already wrote or silently "
    + "duplicates it. Run it once, as the developer, then name a verification command (a build or a test "
    + "that proves what it generated) in the dod block instead.";
}
