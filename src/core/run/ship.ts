/**
 * `tldrx ship` — open a pull request from the run's epic branch, with a body
 * written for a PR (issues #15, #167).
 *
 * ## The gap
 *
 * The loop ended at "merge by hand". A finished epic sat on `epic/<slug>`, the
 * thing that explains it sat in `<run>/<phase>/handoff.md`, and nothing carried
 * either one to a PR — so the last step of every pilot run was a human
 * copy-pasting a document into a browser.
 *
 * ## What it does, and the three things it will not do
 *
 * It reads the epic branch off `run.yml` (`build.epic_branch`, written by the
 * Build executor), finds the repo (or repos) that branch lives in, renders the
 * PR body from the LAST phase handoff on disk, and runs one `gh pr create` per
 * repo.
 *
 * ## The body is rendered, not forwarded (issue #167)
 *
 * It used to BE that handoff, sent unedited. A Build handoff is a gate document —
 * it opens `Blocked on: **human approval**` with instructions for the operator of
 * the run — so every PR this verb opened led with an instruction to somebody who
 * was not reading it, and said nothing about the stories that did not settle or
 * the reviewer findings still open. `run/shipBody.ts` is now the ONE renderer:
 * dry-run and the real `--body-file` are the same bytes, and the handoff still
 * travels whole, inside a `<details>` block. A run with no handoff is still
 * REFUSED — the body is built from that document, and cannot be invented without it.
 *
 * ## One branch, several repos (issue #66)
 *
 * Since #57 a chained multi-repo run cuts ONE integration branch, `epic/<run-id>`,
 * with the same name in every repo of the run — so the lookup finds it in more than
 * one, every time, by construction. It used to refuse with `pass one: --repo <name>`,
 * which made the last step of every such run "type the same command once per repo
 * and remember which ones already went through". The owner's decision (2026-09-01,
 * on the issue) is that it opens one PR per repo automatically: the same body, the
 * repo name in the title, and the list of URLs at the end.
 *
 * Three properties that shape the code below:
 *
 *   **One repo is byte-identical.** The common case takes the path it always took
 *   — same title, same four lines, and not one extra process. The `gh pr list`
 *   probe exists for re-runnability across several repos and never runs when there
 *   is only one.
 *
 *   **A partial failure is reported, not swallowed.** PR 2 of 3 failing still opens
 *   PR 3, and the output names every repo on both sides. Exit `2`, because the verb
 *   did not do all of what was asked — but the PRs that were opened are named, so
 *   nobody has to go looking.
 *
 *   **Re-running is safe.** Before creating, each repo is asked whether an open PR
 *   for this branch already exists (`gh pr list --head`); one that has is skipped
 *   and listed. So the fix for a partial failure is `tldrx ship` again, and nothing
 *   else.
 *
 * **It never pushes.** `core/build/git.ts` has no `git push` wrapper on purpose —
 * spec §5, "the phase ends at a human gate, and nothing it runs may publish a
 * branch" — and this verb keeps that rule rather than being the exception to it.
 * A branch the remote has not seen is a REFUSAL naming the exact `git push`
 * command, because publishing a branch is a decision, and a decision belongs to
 * the person, not to the tool that noticed it was needed.
 *
 * **It never writes to the run.** No event, no gate, no cursor, no money. `tldrx
 * ship` is a read of the run and a write to GitHub; a run whose PR was opened is
 * not in a different state from one whose PR was not.
 *
 * **It does not mirror tickets.** The issue asks for that in the same breath, and
 * `tldrx tickets sync` already is that verb — it reads `process.yml`'s
 * `ticket_tool`, holds the two-way status contract and appends `ticket.synced`
 * events. Re-implementing a second, thinner mirror inside `ship` would give the
 * workspace two answers to "is this story mirrored". So `ship` names it as the
 * next step instead. (Flagged on the issue.)
 *
 * ## Why a transport rather than `runtime.spawn` directly
 *
 * Both external binaries — `git` and `gh` — go through one narrow interface that
 * takes a cwd. `core/adapters/transport.ts` has the same idea and the same
 * reason: it is the only way to ASSERT the argument shape of a command the test
 * suite must not actually run. `test/ship.test.ts` drives a recording fake for
 * the unit cases and a stub `gh` on PATH for the one end-to-end case; the real
 * `gh` is never invoked by a test.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runtime } from "../runtime/index.ts";
import { PROJECT_FRAMEWORK_DIR, PROJECT_WORK_DIR } from "../paths.ts";
import { RunStore } from "./RunStore.ts";
import { ambiguousRunLines } from "./openRuns.ts";
import { loadWorkspace, FALLBACK_DEFAULT_BRANCH } from "../../hooks/lib/workspace.ts";
// One name for one binary. `adapters/github.ts` already had to decide what the
// GitHub CLI is called; a second spelling here would be a second thing to keep true.
import { GH_BIN } from "../adapters/github.ts";
import { renderShipBody, type OpenFindingRow } from "./shipBody.ts";
import { latestFixlist, openFindings } from "../build/fixlist.ts";
import { carriedRowsFor } from "../build/carriedRows.ts";
import { BUILD_PHASE, PLAN_PHASE } from "../build/plan.ts";
import { validateStoryFile } from "../schemas/story.ts";
import { STORIES_DIR } from "../plan/validatePlan.ts";
import type { PlanStatus } from "../schemas/planCommon.ts";
// Spec §3's table, from the file that owns it. This module used to spell the
// three numbers itself; `EXIT_GATE_REFUSED` is the same 2 every other gate
// refusal in the CLI exits with, and one spelling is what keeps it that way.
import { EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_OK } from "../../cli/exitCodes.ts";

/** One external command, with the working directory it must run in. */
export interface ShipTransport {
  run(cmd: string, args: readonly string[], cwd: string): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
}

/** The real one: the runtime seam, no shell, the caller's environment. */
export function realShipTransport(): ShipTransport {
  return {
    async run(cmd, args, cwd) {
      const out = await runtime.spawn(cmd, args, { cwd, env: process.env, timeoutMs: SHIP_TIMEOUT_MS });
      return { exitCode: out.timedOut ? 124 : out.exitCode, stdout: out.stdout, stderr: out.stderr };
    },
  };
}

/** `gh pr create` talks to a network; two minutes is generous and finite. */
export const SHIP_TIMEOUT_MS = 120_000;

export const HANDOFF_FILE = "handoff.md";

export interface ShipOptions {
  readonly root: string;
  readonly runId?: string;
  /** `--branch`: which epic branch, when the run cut more than one. */
  readonly branch?: string;
  /** `--repo`: which repo of the workspace the branch lives in. */
  readonly repo?: string;
  /** `--base`: what to open the PR against. Default: the repo's `default_branch`. */
  readonly base?: string;
  readonly draft?: boolean;
  /** Run every check, print the command, create nothing. */
  readonly dryRun?: boolean;
  readonly actor: string;
  readonly at: string;
  readonly transport: ShipTransport;
}

export interface ShipOutcome {
  readonly code: number;
  readonly lines: readonly string[];
}

export async function shipRun(options: ShipOptions): Promise<ShipOutcome> {
  const resolution = RunStore.resolve(options.root, options.runId);
  if (resolution.kind === "ambiguous") {
    return { code: EXIT_GATE_REFUSED, lines: [...ambiguousRunLines(resolution.open)] };
  }
  if (resolution.kind === "none") {
    return {
      code: EXIT_NOT_FOUND,
      lines: [options.runId === undefined || options.runId === ""
        ? `no non-terminal run in ${PROJECT_WORK_DIR}/`
        : `no run '${options.runId}' in ${PROJECT_WORK_DIR}/`],
    };
  }
  const store = resolution.store;

  // --- what to ship, all read off disk before a single process is spawned ----

  const claimed = store.run.build?.epic_branch ?? [];
  if (claimed.length === 0) {
    return refuse([
      `${store.runId} has cut no epic branch, so there is nothing to open a PR from`,
      "  `build.epic_branch` in run.yml is written by the Build stage when it cuts or adopts one;",
      "  a run that has not reached Build, or one whose Build cut nothing, has no branch to ship.",
    ]);
  }
  const branch = pickBranch(claimed, options.branch);
  if (typeof branch !== "string") return branch;

  const handoff = lastHandoff(store.runDir, store.run.phases.map((phase) => phase.id));
  if (handoff === null) {
    return refuse([
      `${store.runId} has no handoff on disk, and the PR body is built from it`,
      `  a stage writes <phase>/${HANDOFF_FILE}; this run has none in `
        + `${store.run.phases.map((p) => p.id).join(", ")}.`,
      "  Run the stage that produces one, or open the PR by hand — this verb will not invent a body.",
    ]);
  }

  // The stories are read once, here, and travel down as DATA: the body needs the
  // fix lists they own, and the state refusal needs the paths the settled ones
  // declare. Two reads would be two answers to "what did this run plan".
  const stories = runStories(store);
  const body = writeShipBody(
    store, branch, handoff, stories, new Set(loadWorkspace(options.root).repos.keys()),
  );
  try {
    return await shipTo(options, store, branch, body, stories);
  } finally {
    // The body's temp directory is the caller's to clean, and it is cleaned:
    // `spawnAgent.ts` does the same in its own `finally`, and a verb that leaks
    // a directory per invocation — including per REFUSAL, since the body is
    // rendered before the first probe — is a verb that fills a machine slowly.
    //
    // `--dry-run` is the one exception, deliberately: the command it printed
    // names that file, and an operator who copies the line has to find a body
    // there. Nothing else ever reads it again.
    if (options.dryRun !== true) rmSync(dirname(body.path), { recursive: true, force: true });
  }
}

/** Everything after the body exists: the outside world, and one PR per repo. */
async function shipTo(
  options: ShipOptions,
  store: RunStore,
  branch: string,
  body: ShipBody,
  stories: readonly ShipStory[],
): Promise<ShipOutcome> {
  const gh = await options.transport.run(GH_BIN, ["--version"], options.root);
  if (gh.exitCode !== 0) {
    return refuse([
      "`gh` is not usable here, and it is what opens the PR",
      `  \`${GH_BIN} --version\` exited ${String(gh.exitCode)}${firstLine(gh.stderr) === "" ? "" : `: ${firstLine(gh.stderr)}`}`,
      "  install it (`brew install gh`, or https://cli.github.com) and `gh auth login`, then try again.",
      "  Nothing was created and nothing was pushed.",
    ]);
  }

  const repos = await findRepos(options, store, branch);
  if ("code" in repos) return repos;

  const excuses = settledTouches(stories);
  const only = repos[0];
  if (repos.length === 1 && only !== undefined) {
    return await shipOne(options, store, branch, only, body, excuses);
  }
  return await shipMany(options, store, branch, repos, body, excuses);
}

/**
 * One repo — the path this verb has always taken, unchanged down to the wording.
 *
 * Kept whole rather than expressed as `shipMany` with a list of one: the four lines
 * it prints are what an operator's eye and more than one test are keyed on, and a
 * "unified" renderer that agrees with them today would be free to stop agreeing
 * with them tomorrow. `test/ship-multi-repo.test.ts` asserts them as exact strings.
 */
async function shipOne(
  options: ShipOptions,
  store: RunStore,
  branch: string,
  repo: ShipRepo,
  body: ShipBody,
  excuses: readonly StateExcuse[],
): Promise<ShipOutcome> {
  const prepared = await prepareRepo(options, repo, branch, excuses);
  if (!prepared.ok) return refuse(prepared.lines);
  const base = prepared.base;

  const args = createArgs(branch, base, store.run.title, body.path, options.draft === true);
  const command = `gh ${args.map(quote).join(" ")}`;

  if (options.dryRun === true) {
    return {
      code: EXIT_OK,
      lines: [
        `would open a PR for ${store.runId} from \`${branch}\` into \`${base}\` (${repo.name})`,
        `  body: ${bodyRecipe(body)} (${String(body.bytes)} B)`,
        `  cwd:  ${repo.dir}`,
        `  ${command}`,
        "  --dry-run: nothing was created.",
      ],
    };
  }

  const created = await options.transport.run(GH_BIN, args, repo.dir);
  if (created.exitCode !== 0) {
    return refuse([
      `\`gh pr create\` failed (exit ${String(created.exitCode)}) — no PR was opened`,
      ...(firstLine(created.stderr) === "" ? [] : [`  ${firstLine(created.stderr)}`]),
      `  the command, to run by hand: ${command}`,
    ]);
  }

  const url = lastUrl(created.stdout) ?? lastUrl(created.stderr);
  return {
    code: EXIT_OK,
    lines: [
      `opened a PR for ${store.runId} from \`${branch}\` into \`${base}\` (${repo.name})`,
      `  ${url ?? "gh printed no URL — check `gh pr list`"}`,
      `  body: ${bodyRecipe(body)}`,
      `  next: \`tldrx tickets sync --run ${store.runId}\` mirrors the plan's epics and stories, `
        + "if this workspace configures a ticket tool.",
    ],
  };
}

/** What happened in ONE repo. The list of these is the output (issue #66). */
interface RepoOutcome {
  readonly repo: ShipRepo;
  readonly kind: "opened" | "existing" | "would" | "failed";
  readonly url?: string;
  /** The `gh pr create` that ran, or would. Printed for `--dry-run` and for failures. */
  readonly command?: string;
  readonly base?: string;
  /** A failure's own sentences — the same ones one repo would have been refused with. */
  readonly detail?: readonly string[];
}

/**
 * Several repos sharing one branch name: one PR each, in the run's repo order.
 *
 * No repo's problem stops another's PR. A repo that cannot be shipped to — no
 * remote, an unpushed branch, a `gh` that refused — is recorded and the loop moves
 * on, because the alternative (abort on the first failure) leaves the operator with
 * a half-shipped run and no statement of which half.
 */
async function shipMany(
  options: ShipOptions,
  store: RunStore,
  branch: string,
  repos: readonly ShipRepo[],
  body: ShipBody,
  excuses: readonly StateExcuse[],
): Promise<ShipOutcome> {
  const results: RepoOutcome[] = [];
  for (const repo of repos) {
    const prepared = await prepareRepo(options, repo, branch, excuses);
    if (!prepared.ok) {
      results.push({ repo, kind: "failed", detail: prepared.lines });
      continue;
    }
    // The repo name goes IN the title, so three tabs of the same PR are tellable apart.
    const title = `${store.run.title} (${repo.name})`;
    const args = createArgs(branch, prepared.base, title, body.path, options.draft === true);
    const command = `gh ${args.map(quote).join(" ")}`;

    if (options.dryRun === true) {
      results.push({ repo, kind: "would", base: prepared.base, command });
      continue;
    }

    // Re-runnability: a repo whose PR is already open is skipped, never asked for a
    // second one. `gh pr create` would refuse it anyway — but as a FAILURE, which
    // would make re-running after a partial failure look worse than the first try.
    const already = await openPrFor(options, repo, branch);
    if (already !== null) {
      results.push({ repo, kind: "existing", url: already, base: prepared.base });
      continue;
    }

    const created = await options.transport.run(GH_BIN, args, repo.dir);
    if (created.exitCode !== 0) {
      results.push({
        repo,
        kind: "failed",
        command,
        detail: [
          `\`gh pr create\` failed (exit ${String(created.exitCode)}) — no PR was opened`,
          ...(firstLine(created.stderr) === "" ? [] : [`  ${firstLine(created.stderr)}`]),
          `  the command, to run by hand: ${command}`,
        ],
      });
      continue;
    }
    results.push({
      repo,
      kind: "opened",
      base: prepared.base,
      url: lastUrl(created.stdout) ?? lastUrl(created.stderr) ?? undefined,
    });
  }
  return renderMany(store, branch, body, results, options.dryRun === true);
}

/**
 * The multi-repo report: a head line with the counts, one line per repo, and what a
 * partial failure should do next.
 *
 * Repo order, not grouped by outcome: the operator asked for these repos in this
 * order and two runs of the same command must read the same way.
 */
function renderMany(
  store: RunStore,
  branch: string,
  shipBody: ShipBody,
  results: readonly RepoOutcome[],
  dryRun: boolean,
): ShipOutcome {
  const width = Math.max(...results.map((result) => result.repo.name.length), 1);
  const pad = (name: string): string => name.padEnd(width);
  const gap = " ".repeat(width);
  const opened = results.filter((result) => result.kind === "opened");
  const existing = results.filter((result) => result.kind === "existing");
  const failed = results.filter((result) => result.kind === "failed");
  const total = String(results.length);
  const names = results.map((result) => result.repo.name).join(", ");
  const body = `  body: ${bodyRecipe(shipBody)}, the same one in every repo`;

  if (dryRun) {
    return {
      code: EXIT_OK,
      lines: [
        `would open ${total} PRs for ${store.runId} from \`${branch}\` (${names})`,
        `  body: ${bodyRecipe(shipBody)} (${String(shipBody.bytes)} B), the same one in every repo`,
        ...results.flatMap((result) => result.kind === "failed"
          ? [`  ${pad(result.repo.name)}  cannot: ${result.detail?.[0] ?? ""}`]
          : [
            `  ${pad(result.repo.name)}  into \`${result.base ?? ""}\` (cwd ${result.repo.dir})`,
            `  ${gap}  ${result.command ?? ""}`,
          ]),
        "  --dry-run: nothing was created.",
      ],
    };
  }

  const head = failed.length === 0
    ? `opened ${String(opened.length)} of ${total} PRs for ${store.runId} from \`${branch}\` (${names})`
      + (existing.length === 0 ? "" : ` — ${String(existing.length)} already open`)
    : `opened ${String(opened.length)} of ${total} PRs for ${store.runId} from \`${branch}\` (${names})`
      + ` — ${String(failed.length)} repo${failed.length === 1 ? "" : "s"} failed`;

  const rows = results.flatMap((result) => {
    const name = pad(result.repo.name);
    if (result.kind === "opened") return [`  ${name}  ${result.url ?? "gh printed no URL"}`];
    if (result.kind === "existing") return [`  ${name}  already open: ${result.url ?? ""}`];
    return [
      `  ${name}  FAILED: ${result.detail?.[0] ?? ""}`,
      ...(result.detail ?? []).slice(1).map((line) => `  ${gap}  ${line.trimStart()}`),
    ];
  });

  const standing = opened.length + existing.length;
  const tail = failed.length === 0
    ? [
      body,
      `  next: \`tldrx tickets sync --run ${store.runId}\` mirrors the plan's epics and stories, `
        + "if this workspace configures a ticket tool.",
    ]
    : [
      body,
      `  the ${String(standing)} PR${standing === 1 ? "" : "s"} above ${standing === 1 ? "is" : "are"} open. `
        + "Run `tldrx ship` again to retry the rest — a repo whose PR is already open is skipped, "
        + "so re-running opens nothing twice.",
    ];

  return { code: failed.length === 0 ? EXIT_OK : EXIT_GATE_REFUSED, lines: [head, ...rows, ...tail] };
}

/** The `gh pr create` argv. Identical for one repo and for many but the title. */
function createArgs(
  branch: string,
  base: string,
  title: string,
  bodyFile: string,
  draft: boolean,
): readonly string[] {
  return [
    "pr", "create",
    "--head", branch,
    "--base", base,
    "--title", title,
    "--body-file", bodyFile,
    ...(draft ? ["--draft"] : []),
  ];
}

interface Prepared {
  readonly ok: true;
  readonly remote: string;
  readonly base: string;
}

/**
 * Everything that must be true of ONE repo before a PR can be opened in it, and the
 * refusal sentences for when it is not.
 *
 * The lines are shared on purpose: they are what a single-repo run is refused with,
 * and what a multi-repo run reports beside the repo's name. Two spellings of "the
 * branch is not on origin" would be two pieces of advice for one problem.
 */
async function prepareRepo(
  options: ShipOptions,
  repo: ShipRepo,
  branch: string,
  excuses: readonly StateExcuse[],
): Promise<Prepared | { readonly ok: false; readonly lines: readonly string[] }> {
  const remotes = await listRemotes(options.transport, repo.dir);
  const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : null;
  if (remote === undefined || remote === null) {
    return {
      ok: false,
      lines: [
        remotes.length === 0
          ? `\`${repo.name}\` has no git remote, so there is nowhere to open a PR`
          : `\`${repo.name}\` has ${String(remotes.length)} remotes and none is called \`origin\` `
            + `(${remotes.join(", ")}) — this verb will not pick one`,
        remotes.length === 0
          ? "  add one (`git remote add origin <url>`) and push the branch, then try again."
          : "  rename one to `origin`, or open the PR by hand.",
      ],
    };
  }

  // The branch must ALREADY be on the remote. tldrx does not publish branches.
  const onRemote = await options.transport.run("git", ["ls-remote", "--heads", remote, branch], repo.dir);
  if (onRemote.exitCode !== 0 || onRemote.stdout.trim() === "") {
    return {
      ok: false,
      lines: [
        `\`${branch}\` is not on \`${remote}\`, and tldrx does not publish branches`,
        `  push it yourself, then run this again:`,
        `    git -C ${repo.dir} push -u ${remote} ${branch}`,
        "  (spec §5: nothing the framework runs may publish a branch — that decision is yours.)",
      ],
    };
  }

  const base = options.base
    ?? loadWorkspace(options.root).defaultBranches.get(repo.name)
    ?? FALLBACK_DEFAULT_BRANCH;

  const state = await stateOnBranch(options.transport, repo.dir, base, branch);
  const { refused, excused } = subtractExcused(state, excuses, repo.name);
  if (refused.length > 0) {
    const shown = refused.slice(0, 5);
    return {
      ok: false,
      lines: [
        `\`${branch}\` carries ${String(refused.length)} change(s) to tldrx's own state, and a PR that `
          + "merges them will break the next `git pull` in this workspace",
        ...shown.map((path) => `    ${path}`),
        ...(refused.length > shown.length ? [`    …and ${String(refused.length - shown.length)} more`] : []),
        `  \`${PROJECT_WORK_DIR}/\` and \`${PROJECT_FRAMEWORK_DIR}/\` are written LIVE into this checkout for the `
          + "length of a run, so the same paths arriving in a merge meet a dirty tree — measured on",
        "  aparece-v2, 2026-09-02: a refused pull over 5 modified and ~40 untracked paths (gh #102).",
        "  An epic under review carries feature code; the run's state belongs on the branch it was",
        `  written on, where \`tldrx approve\` now commits it. To take it back off the epic:`,
        `    git -C ${repo.dir} checkout ${base} -- ${remedyPaths(refused, excused)}`,
        `    git -C ${repo.dir} commit -m "keep tldrx state off the epic"`,
        "  (done on a checkout of the branch — a forward commit, never a rebase.)",
        // The subtraction is shown rather than left silent: an operator who reads
        // this list needs to know why a path they can see on the branch is not in
        // it, and a refusal that quietly drops evidence is the harder one to trust.
        ...excused.map((row) =>
          `  (\`${row.path}\` is excused by ${row.storyId}, which declares it in \`touches:\` — `
          + "the command above leaves it on the branch)"),
      ],
    };
  }
  return { ok: true, remote, base };
}

/**
 * What the remedy command checks out of `base` — the REFUSED paths, never a path
 * a settled story was just excused for.
 *
 * The blanket `-- tldrx-work .tldrx` is right and stays right while every state
 * path on the branch is refused, which is how it was until #167: the two
 * directories ARE the refused set, and naming them survives a path list that
 * would otherwise run to forty entries.
 *
 * The moment something is excused it stops being right: `git checkout <base> --
 * .tldrx` reverts the `.tldrx/workspace.yml` edit the settled story was written
 * to make, and the operator ships a branch missing the work — with the excuse
 * printed three lines below the command that undid it. So when anything was
 * excused, the command names exactly what is refused and nothing else.
 */
function remedyPaths(
  refused: readonly string[],
  excused: readonly StateExcuse[],
): string {
  if (excused.length === 0) return `${PROJECT_WORK_DIR} ${PROJECT_FRAMEWORK_DIR}`;
  // Quoted PER PATH. These are real paths off `git diff`, and joining them with a
  // bare space turned one containing a space into two pathspecs — `git checkout
  // main -- a b.yml` — a line the operator cannot paste. `quote` is the same
  // echo-only quoter the printed `gh` command uses, and it leaves an ordinary
  // path bare; nothing here is ever run by a shell. The two constants above need
  // none: they are literals with no metacharacter in them.
  return refused.map(quote).join(" ");
}

/**
 * A path a SETTLED story declares in `touches:`, and the story that declares it.
 *
 * The #102 refusal had no allowed move (#167): a story that legitimately edits
 * `.tldrx/workspace.yml` — adding a repo, declaring a command — could not be
 * shipped at all, because the branch carrying its work carries the edit the plan
 * asked for. A DECLARED path is not accidental state: `touches:` is the story's
 * own statement of what it would change, written before the work and validated
 * with the plan.
 *
 * Settled means `done`, and only `done`. A story at `review` or `blocked` has a
 * declaration and no verdict — a plan, not a fact — and excusing on it would let
 * an unfinished story's intention wave through a real state change.
 *
 * And it answers for ONE repo. `touches:` is a repo-relative path list on a story
 * that names its `repo:` (spec §2.13), while `stateOnBranch` asks `git diff`
 * inside each repo's own directory — so an excuse that travelled would have a
 * story in `app` waving through the same relative path on the branch in `api`,
 * and the refusal would name a story that never touched that repo.
 */
interface StateExcuse {
  readonly path: string;
  readonly storyId: string;
  /** The `repo:` the declaring story names — the only repo this excuse answers for. */
  readonly repo: string;
}

function settledTouches(stories: readonly ShipStory[]): readonly StateExcuse[] {
  const rows: StateExcuse[] = [];
  for (const story of stories) {
    if (story.status !== "done") continue;
    for (const path of story.touches) rows.push({ path, storyId: story.id, repo: story.repo });
  }
  return rows;
}

/**
 * The state changes still refused, and the ones a settled story answers for.
 *
 * Prefix-matched at a SEGMENT boundary, because `touches:` may name a directory
 * (`.tldrx/experts/`) as readily as a file. `path.startsWith(declared)` on its
 * own would let a declared `.tldrx/work` excuse `.tldrx/workspace.yml`, which is
 * a different file with a different meaning.
 */
function subtractExcused(
  state: readonly string[],
  excuses: readonly StateExcuse[],
  repo: string,
): { readonly refused: readonly string[]; readonly excused: readonly StateExcuse[] } {
  const refused: string[] = [];
  const excused: StateExcuse[] = [];
  for (const path of state) {
    const by = excuses.find((excuse) => excuse.repo === repo && covers(excuse.path, path));
    if (by === undefined) refused.push(path);
    else excused.push({ path, storyId: by.storyId, repo });
  }
  return { refused, excused };
}

function covers(declared: string, path: string): boolean {
  const trimmed = declared.replace(/\/+$/, "");
  return trimmed !== "" && (path === trimmed || path.startsWith(`${trimmed}/`));
}

/**
 * Which of tldrx's own paths this branch changes that its base does not (#102).
 *
 * Three dots, so the answer is "what the BRANCH did" and not "how far the base has
 * moved since" — a trunk that gained a run's state after the epic was cut must not
 * read as the epic carrying it.
 *
 * A `git diff` that fails answers the empty list. "I could not tell" has to behave
 * like "there is nothing here": a missing local base ref, or a git that is unwell,
 * is not evidence that a PR should be refused.
 */
async function stateOnBranch(
  transport: ShipTransport,
  cwd: string,
  base: string,
  branch: string,
): Promise<readonly string[]> {
  const diff = await transport.run(
    "git",
    ["diff", "--name-only", `${base}...${branch}`, "--", PROJECT_WORK_DIR, PROJECT_FRAMEWORK_DIR],
    cwd,
  );
  if (diff.exitCode !== 0) return [];
  return diff.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

/**
 * The URL of an OPEN PR for this branch in this repo, or null.
 *
 * `gh` failing, and `gh` printing something that is not the JSON it was asked for,
 * both answer null: "I could not tell" must behave like "there is none", so that a
 * transient `gh` problem can never silently turn a real ship into a skip.
 */
async function openPrFor(options: ShipOptions, repo: ShipRepo, branch: string): Promise<string | null> {
  const listed = await options.transport.run(
    GH_BIN, ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--limit", "1"], repo.dir,
  );
  if (listed.exitCode !== 0) return null;
  let rows: unknown;
  try {
    rows = JSON.parse(listed.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const url = (rows[0] as { url?: unknown } | undefined)?.url;
  return typeof url === "string" && url !== "" ? url : null;
}

/**
 * Which of the run's epic branches to ship. Never a guess between several.
 *
 * Exported for `tldrx watch arm` (gh #69), which has to answer the same question
 * about the same `run.yml` list before it can ask `gh` about a PR. Two answers to
 * "which branch did this run ship" is how a poller ends up watching a branch
 * nobody opened a PR from.
 */
export function pickBranch(claimed: readonly string[], wanted?: string): string | ShipOutcome {
  const asked = wanted?.trim() ?? "";
  if (asked !== "") {
    if (!claimed.includes(asked)) {
      return refuse([
        `\`${asked}\` is not one of this run's epic branches`,
        `  it cut ${claimed.join(", ")}`,
        "  shipping a branch the run did not cut would attribute somebody else's work to it.",
      ]);
    }
    return asked;
  }
  const only = claimed[0];
  if (claimed.length > 1 || only === undefined) {
    return refuse([
      `this run cut ${String(claimed.length)} epic branches and no --branch says which to ship`,
      `  ${claimed.join(", ")}`,
      `  pass one: \`tldrx ship --branch ${claimed[0] ?? "<branch>"}\``,
    ]);
  }
  return only;
}

export interface ShipRepo {
  readonly name: string;
  readonly dir: string;
}

/**
 * The part of `ShipOptions` that `findRepos` actually reads.
 *
 * Narrowed (rather than passing the whole of `ShipOptions`) so `watch arm` can
 * call it without pretending to be a ship: it has no handoff, no `--draft` and no
 * `at`. `ShipOptions` still satisfies this structurally, so both call sites below
 * are unchanged.
 */
export interface RepoLookup {
  readonly root: string;
  /** `--repo`, when the caller narrowed it to one. */
  readonly repo?: string;
  readonly transport: ShipTransport;
}

/**
 * EVERY repo of the run whose branch this is, in the run's declared order.
 *
 * `run.yml` records the branch NAME and not its repo (`RunBuild.epic_branch` is a
 * list of strings), so it is looked up: the run's declared repos are asked, in
 * order, whether they have a ref by that name. Zero is still a refusal — a branch
 * nobody has is not a PR anybody can open.
 *
 * SEVERAL used to be a refusal too ("pass one: --repo"). Since #57 that is the
 * NORMAL shape of a chained multi-repo run — one integration branch, the same name
 * in every repo — so the answer is now the list, and `shipMany` opens one PR in
 * each (issue #66, owner decision 2026-09-01). `--repo` still narrows it to one,
 * which is the escape hatch for the operator who wants exactly one of them.
 */
export async function findRepos(
  options: RepoLookup,
  store: RunStore,
  branch: string,
): Promise<readonly ShipRepo[] | ShipOutcome> {
  const workspace = loadWorkspace(options.root);
  const declared = store.run.repos.length > 0 ? store.run.repos : [...workspace.repos.keys()];
  const wanted = options.repo?.trim() ?? "";
  const names = wanted === "" ? declared : [wanted];

  if (wanted !== "" && !workspace.repos.has(wanted)) {
    return refuse([
      `\`${wanted}\` is not a repo of this workspace`,
      `  .tldrx/workspace.yml names ${[...workspace.repos.keys()].join(", ") || "none"}`,
    ]);
  }

  const found: ShipRepo[] = [];
  for (const name of names) {
    const rel = workspace.repos.get(name);
    if (rel === undefined) continue;
    const dir = resolve(options.root, rel);
    if (!existsSync(dir)) continue;
    if (wanted !== "") return [{ name, dir }];
    const has = await options.transport.run(
      "git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], dir,
    );
    if (has.exitCode === 0) found.push({ name, dir });
  }

  if (found.length === 0) {
    return refuse([
      `no repo of this workspace has a branch \`${branch}\``,
      `  looked in ${names.join(", ") || "no repo at all"}`,
      "  the branch may have been deleted, or it may live in a repo workspace.yml does not name.",
    ]);
  }
  return found;
}

interface Handoff {
  readonly rel: string;
  readonly path: string;
  readonly bytes: number;
  /** The document itself — `run/shipBody.ts` folds it into the PR body whole. */
  readonly text: string;
}

/**
 * The LAST phase handoff the run has on disk.
 *
 * Last rather than first, and by the run's own phase order rather than by mtime:
 * the handoff a PR wants is the one written by the work being shipped, which on a
 * run that built something is `04-build/handoff.md`. A run that stopped earlier
 * ships the furthest handoff it got to, which is the honest answer to "what does
 * this branch contain".
 */
function lastHandoff(runDir: string, phases: readonly string[]): Handoff | null {
  let found: Handoff | null = null;
  for (const phase of phases) {
    const path = join(runDir, phase, HANDOFF_FILE);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (text.trim() === "") continue;
    found = { rel: `${phase}/${HANDOFF_FILE}`, path, bytes: Buffer.byteLength(text, "utf8"), text };
  }
  return found;
}

/** The PR body: rendered once, written once, the same file in every repo. */
interface ShipBody {
  /** Absolute path of the file `--body-file` is given. */
  readonly path: string;
  readonly bytes: number;
  /** The handoff it folds in, run-relative — what the output lines name. */
  readonly handoffRel: string;
  /** How many open fix-list findings it lists. `0` is a measurement, not a silence. */
  readonly open: number;
}

/**
 * Render the body and put it somewhere `gh` can read it.
 *
 * The file goes in a fresh OS temp directory and NOT in the run tree, for the two
 * reasons this verb already lives by: `tldrx ship` never writes to the run, and a
 * file written under `tldrx-work/` or into a repo would become the next `git
 * status` line — over the very paths `prepareRepo` refuses a branch for.
 */
function writeShipBody(
  store: RunStore,
  branch: string,
  handoff: Handoff,
  stories: readonly ShipStory[],
  repoNames: ReadonlySet<string>,
): ShipBody {
  const rows = openFixFindings(store, stories);
  const text = renderShipBody({
    runId: store.runId,
    title: store.run.title,
    branch,
    handoff: handoff.text,
    handoffRel: handoff.rel,
    openFindings: rows,
    // `ship` applies NO predicate of its own here (#171). `carriedRowsFor` is the
    // one implementation of "carried, and nobody's story owns it" — it calls
    // `carriedFindings` and `unownedFindings`, and reads the story surfaces from
    // the same pair the boundary gate reads, `03-plan/stories/` first and
    // `04-build/implicit-plan.yml` on a Plan-skipped run. This verb calls it
    // because it runs in a separate process, not because it has a second opinion.
    carriedFindings: carriedRowsFor(store.runDir, repoNames, store.run.phases.map((phase) => phase.id)),
  });
  const path = join(mkdtempSync(join(tmpdir(), "tldrx-ship-")), "pr-body.md");
  writeFileSync(path, text, "utf8");
  return { path, bytes: Buffer.byteLength(text, "utf8"), handoffRel: handoff.rel, open: rows.length };
}

/**
 * What the body IS, in one clause — the only sentence in this file that says so.
 *
 * It used to read `body: 04-build/handoff.md` on the success path, which was true
 * while the handoff WAS the body and stopped being true the moment it became one
 * section of a rendered document. The open-finding count is stated on both sides,
 * `no open findings` included: a reviewer deciding whether to look at the PR is
 * owed the negative case, and a silent zero and an unmeasured zero read alike.
 */
function bodyRecipe(body: ShipBody): string {
  const findings = body.open === 0
    ? "no open findings"
    : `${String(body.open)} open finding${body.open === 1 ? "" : "s"}`;
  return `rendered from ${body.handoffRel} · ${findings}`;
}

/** The three questions `ship` asks of a story: settled, where, and what it touches. */
interface ShipStory {
  readonly id: string;
  readonly status: PlanStatus;
  /** `repo:` — the repo its `touches:` are relative to, and the only one they answer for. */
  readonly repo: string;
  readonly touches: readonly string[];
}

/**
 * Directories to look in for a phase's artefacts — the two the Build executor
 * addresses by name, then the run's declared phases.
 *
 * Both halves are needed, measured: a `build-only` run's `run.yml` declares the
 * single phase `04-build` and its plan still sits in `03-plan/stories/`, because
 * that is where `build/plan.ts` reads it from whatever the workflow declares. So
 * walking only the declared phases finds no story at all on the commonest shape
 * this verb ships, and hard-coding only `03-plan` would miss a workflow that
 * names its phases differently.
 *
 * `BUILD_PHASE` is FIRST because one reader below takes the first hit per story:
 * a fix list's only writer puts it under `04-build` (`writeFixlist`'s caller),
 * so the real home has to win any tie.
 */
function phaseDirs(store: RunStore): readonly string[] {
  return [...new Set([BUILD_PHASE, PLAN_PHASE, ...store.run.phases.map((phase) => phase.id)])];
}

/**
 * The run's stories, read tolerantly from whichever phase directory holds them.
 *
 * A story file that does not validate is SKIPPED, not guessed at. That is the
 * fail-closed direction for both readers: an unreadable story excuses no state
 * path and vouches for no fix list, so the worst a broken file can do is leave a
 * refusal standing.
 *
 * ONE ROW PER STORY ID, and the FIRST phase directory that holds it wins — the
 * same tie-break `openFixFindings` states for the fix lists, so the two readers
 * of this list cannot end up reading two different files for one story. Without
 * it a story found in two phase directories was pushed twice, and `settledTouches`
 * built a duplicate excuse from whichever copy said `done`: a stale copy could
 * excuse a state path the live one still has under review. Deduping here can only
 * ever remove an excuse, never add one, which is the direction a state refusal is
 * allowed to move in.
 *
 * Exported for `test/ship.test.ts`: the duplicate is invisible downstream —
 * `subtractExcused` reports one row per state path and `openFixFindings` dedups by
 * id — so the property has to be asserted where it lives.
 */
export function runStories(store: RunStore): readonly ShipStory[] {
  const stories: ShipStory[] = [];
  const seen = new Set<string>();
  for (const phase of phaseDirs(store)) {
    const dir = join(store.runDir, phase, STORIES_DIR);
    if (!existsSync(dir)) continue;
    let names: readonly string[];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      let text: string;
      try {
        text = readFileSync(join(dir, name), "utf8");
      } catch {
        continue;
      }
      // No workspace commands passed: the dod-allowlist rule is about EXECUTING a
      // story, and this only ever reads its front matter (`adapters/collect.ts`
      // reads one the same way, for the same reason).
      const story = validateStoryFile(text).story;
      if (story === null || seen.has(story.id)) continue;
      seen.add(story.id);
      stories.push({ id: story.id, status: story.status, repo: story.repo, touches: story.touches });
    }
  }
  return stories;
}

/**
 * Every fix-list finding still open, in run order, with the file it is open in.
 *
 * `build/fixlist.ts` is called, never re-implemented: `latestFixlist` finds the
 * document and `openFindings` decides what "open" means — `fix-now`, and no
 * resolution the file can point a commit at (#130). A PR body that decided that
 * for itself would be a second answer to the question a story's own settle path
 * already asks.
 *
 * The LATEST round only, which is what the executor's own reader does
 * (`executors/build.ts`, `fixlistFor`): an earlier round is superseded by the one
 * written after it. That is not merely a convention here — `MAX_FIXLIST_ROUNDS`
 * is 1 (`build/fixlist.ts`), so a story has at most one round on disk per run and
 * "latest only" is COMPLETE. If that bound ever rises, this reader has to change
 * with it, or a finding still open in round 1 and absent from round 2 would drop
 * out of the body silently.
 *
 * One story is reported ONCE. A story is looked up in every phase directory
 * because no one of them is guaranteed to be the right one, and the first hit
 * wins — `BUILD_PHASE` is first in that list, which is where a fix list is
 * written. Without the guard, a story with a fix list under two phase directories
 * would have its open findings listed twice, under two different citations, and a
 * reviewer would be told a defect is owed twice over.
 */
function openFixFindings(store: RunStore, stories: readonly ShipStory[]): readonly OpenFindingRow[] {
  const rows: OpenFindingRow[] = [];
  const seen = new Set<string>();
  for (const phase of phaseDirs(store)) {
    for (const story of stories) {
      if (seen.has(story.id)) continue;
      const latest = latestFixlist(store.runDir, phase, story.id);
      if (latest === null) continue;
      seen.add(story.id);
      for (const finding of openFindings(latest.findings)) rows.push({ rel: latest.rel, finding });
    }
  }
  return rows;
}

async function listRemotes(transport: ShipTransport, cwd: string): Promise<readonly string[]> {
  const out = await transport.run("git", ["remote"], cwd);
  if (out.exitCode !== 0) return [];
  return out.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

/** The last URL-looking line of `gh`'s output. `gh pr create` prints exactly one. */
function lastUrl(text: string): string | null {
  const urls = text.split("\n").map((line) => line.trim()).filter((line) => /^https?:\/\/\S+$/.test(line));
  return urls.at(-1) ?? null;
}

function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim();
}

/** Shell quoting for the ECHOED command only — nothing here is ever run by a shell. */
function quote(arg: string): string {
  return /^[A-Za-z0-9._\/:@=-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function refuse(lines: readonly string[]): ShipOutcome {
  return { code: EXIT_GATE_REFUSED, lines };
}
