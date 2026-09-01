/**
 * `tldrx ship` — open a pull request from the run's epic branch, with the run's
 * handoff as the body (issue #15).
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
 * Build executor), finds the repo (or repos) that branch lives in, takes the LAST
 * phase handoff on disk as the body, and runs one `gh pr create` per repo.
 *
 * ## One branch, several repos (issue #66)
 *
 * Since #57 a chained multi-repo run cuts ONE integration branch, `epic/<run-id>`,
 * with the same name in every repo of the run — so the lookup finds it in more than
 * one, every time, by construction. It used to refuse with `pass one: --repo <name>`,
 * which made the last step of every such run "type the same command once per repo
 * and remember which ones already went through". The owner's decision (2026-09-01,
 * on the issue) is that it opens one PR per repo automatically: the same handoff as
 * the body, the repo name in the title, and the list of URLs at the end.
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
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runtime } from "../runtime/index.ts";
import { PROJECT_WORK_DIR } from "../paths.ts";
import { RunStore } from "./RunStore.ts";
import { ambiguousRunLines } from "./openRuns.ts";
import { loadWorkspace, FALLBACK_DEFAULT_BRANCH } from "../../hooks/lib/workspace.ts";
// One name for one binary. `adapters/github.ts` already had to decide what the
// GitHub CLI is called; a second spelling here would be a second thing to keep true.
import { GH_BIN } from "../adapters/github.ts";

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

const EXIT_OK = 0;
/** Spec §3. Every refusal below is a refusal to act, which is `2`. */
const EXIT_REFUSED = 2;
const EXIT_NOT_FOUND = 3;

export async function shipRun(options: ShipOptions): Promise<ShipOutcome> {
  const resolution = RunStore.resolve(options.root, options.runId);
  if (resolution.kind === "ambiguous") {
    return { code: EXIT_REFUSED, lines: [...ambiguousRunLines(resolution.open)] };
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
      `${store.runId} has no handoff on disk, and the handoff is the PR body`,
      `  a stage writes <phase>/${HANDOFF_FILE}; this run has none in `
        + `${store.run.phases.map((p) => p.id).join(", ")}.`,
      "  Run the stage that produces one, or open the PR by hand — this verb will not invent a body.",
    ]);
  }

  // --- the outside world ----------------------------------------------------

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

  const only = repos[0];
  if (repos.length === 1 && only !== undefined) {
    return await shipOne(options, store, branch, only, handoff);
  }
  return await shipMany(options, store, branch, repos, handoff);
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
  handoff: Handoff,
): Promise<ShipOutcome> {
  const prepared = await prepareRepo(options, repo, branch);
  if (!prepared.ok) return refuse(prepared.lines);
  const base = prepared.base;

  const args = createArgs(branch, base, store.run.title, handoff.path, options.draft === true);
  const command = `gh ${args.map(quote).join(" ")}`;

  if (options.dryRun === true) {
    return {
      code: EXIT_OK,
      lines: [
        `would open a PR for ${store.runId} from \`${branch}\` into \`${base}\` (${repo.name})`,
        `  body: ${handoff.rel} (${String(handoff.bytes)} B)`,
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
      `  body: ${handoff.rel}`,
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
  handoff: Handoff,
): Promise<ShipOutcome> {
  const results: RepoOutcome[] = [];
  for (const repo of repos) {
    const prepared = await prepareRepo(options, repo, branch);
    if (!prepared.ok) {
      results.push({ repo, kind: "failed", detail: prepared.lines });
      continue;
    }
    // The repo name goes IN the title, so three tabs of the same PR are tellable apart.
    const title = `${store.run.title} (${repo.name})`;
    const args = createArgs(branch, prepared.base, title, handoff.path, options.draft === true);
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
  return renderMany(store, branch, handoff, results, options.dryRun === true);
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
  handoff: Handoff,
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
  const body = `  body: ${handoff.rel}, the same one in every repo`;

  if (dryRun) {
    return {
      code: EXIT_OK,
      lines: [
        `would open ${total} PRs for ${store.runId} from \`${branch}\` (${names})`,
        `  body: ${handoff.rel} (${String(handoff.bytes)} B), the same one in every repo`,
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

  return { code: failed.length === 0 ? EXIT_OK : EXIT_REFUSED, lines: [head, ...rows, ...tail] };
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
  return { ok: true, remote, base };
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
    found = { rel: `${phase}/${HANDOFF_FILE}`, path, bytes: Buffer.byteLength(text, "utf8") };
  }
  return found;
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
  return { code: EXIT_REFUSED, lines };
}
