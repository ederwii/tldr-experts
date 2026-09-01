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
 * Build executor), finds the repo that branch lives in, takes the LAST phase
 * handoff on disk as the body, and runs one `gh pr create`. That is all.
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

  const repo = await findRepo(options, store, branch);
  if ("code" in repo) return repo;

  const remotes = await listRemotes(options.transport, repo.dir);
  const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : null;
  if (remote === undefined || remote === null) {
    return refuse([
      remotes.length === 0
        ? `\`${repo.name}\` has no git remote, so there is nowhere to open a PR`
        : `\`${repo.name}\` has ${String(remotes.length)} remotes and none is called \`origin\` `
          + `(${remotes.join(", ")}) — this verb will not pick one`,
      remotes.length === 0
        ? "  add one (`git remote add origin <url>`) and push the branch, then try again."
        : "  rename one to `origin`, or open the PR by hand.",
    ]);
  }

  // The branch must ALREADY be on the remote. tldrx does not publish branches.
  const onRemote = await options.transport.run(
    "git", ["ls-remote", "--heads", remote, branch], repo.dir,
  );
  if (onRemote.exitCode !== 0 || onRemote.stdout.trim() === "") {
    return refuse([
      `\`${branch}\` is not on \`${remote}\`, and tldrx does not publish branches`,
      `  push it yourself, then run this again:`,
      `    git -C ${repo.dir} push -u ${remote} ${branch}`,
      "  (spec §5: nothing the framework runs may publish a branch — that decision is yours.)",
    ]);
  }

  const base = options.base ?? loadWorkspace(options.root).defaultBranches.get(repo.name) ?? FALLBACK_DEFAULT_BRANCH;
  const args = [
    "pr", "create",
    "--head", branch,
    "--base", base,
    "--title", store.run.title,
    "--body-file", handoff.path,
    ...(options.draft === true ? ["--draft"] : []),
  ];
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

/** Which of the run's epic branches to ship. Never a guess between several. */
function pickBranch(claimed: readonly string[], wanted?: string): string | ShipOutcome {
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

interface ShipRepo {
  readonly name: string;
  readonly dir: string;
}

/**
 * The repo the epic branch lives in.
 *
 * `run.yml` records the branch NAME and not its repo (`RunBuild.epic_branch` is a
 * list of strings), so it is looked up: the run's declared repos are asked, in
 * order, whether they have a ref by that name. Exactly one is an answer; zero and
 * several are both refusals, because picking either way would open a PR in a repo
 * nobody named.
 */
async function findRepo(
  options: ShipOptions,
  store: RunStore,
  branch: string,
): Promise<ShipRepo | ShipOutcome> {
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
    if (wanted !== "") return { name, dir };
    const has = await options.transport.run(
      "git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], dir,
    );
    if (has.exitCode === 0) found.push({ name, dir });
  }

  const only = found[0];
  if (only === undefined) {
    return refuse([
      `no repo of this workspace has a branch \`${branch}\``,
      `  looked in ${names.join(", ") || "no repo at all"}`,
      "  the branch may have been deleted, or it may live in a repo workspace.yml does not name.",
    ]);
  }
  if (found.length > 1) {
    return refuse([
      `\`${branch}\` exists in ${String(found.length)} repos (${found.map((r) => r.name).join(", ")})`,
      `  pass one: \`tldrx ship --repo ${only.name}\``,
    ]);
  }
  return only;
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
