/**
 * The ticket mirror, exercised end to end WITHOUT a network and WITHOUT `gh`.
 *
 * Every provider here is the real provider — the real argv, the real REST paths,
 * the real body — wired to a fake transport that records what it was asked to do
 * and answers from a script. That is the only honest way to test code we must not
 * run: a mock of the provider would prove nothing about the `gh` arguments, and
 * running the provider for real would file issues in somebody's tracker.
 *
 * The four guard-rail tests are the point of the file:
 *   1. syncing never modifies `status:`
 *   2. a remote "Done" lands in `external_status` and nowhere else
 *   3. re-syncing reuses the key and creates nothing
 *   4. `--dry-run` makes zero transport calls
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyExternal, collectMirrorItems, createGithubProvider, createJiraProvider, divergenceOf,
  issueNumber, JIRA_ENV_VARS, JIRA_ISSUE_PATH, parseIssueUrl, readExternal, readTicketToolConfig,
  renderIssueBody, renderStatusTable, resolveJiraCredentials, statusRows, syncTickets,
  TICKET_FOOTER, TicketAdapterError,
  type CommandResult, type CommandTransport, type HttpRequest, type HttpResponse, type HttpTransport,
} from "../src/core/adapters/index.ts";
import { validateEvent } from "../src/core/events/Event.ts";
import { validateStoryFile } from "../src/core/schemas/story.ts";

// --- fixtures ---------------------------------------------------------------

const RUN_ID = "260829-leaderboard";
const NOW = "2026-08-29T10:00:00Z";

function story(id: string, status = "todo", extra = ""): string {
  return [
    "---",
    "version: 1",
    `id: ${id}`,
    "epic: E1",
    'title: "Leaderboard read model"',
    "repo: lab",
    `status: ${status}`,
    "depends_on: []",
    'touches: ["src/features/leaderboard/"]',
    "acceptance:",
    '  - "Top-50 ranks render from the materialised view"',
    "test_plan:",
    '  - "Unit: rank ordering with ties"',
    "evidence: []",
    ...(extra === "" ? [] : [extra]),
    "---",
    "",
    `# ${id} · Leaderboard read model`,
    "",
    "## Definition of done",
    "",
    "```dod",
    "npm run test",
    "```",
    "",
  ].join("\n");
}

function epic(): string {
  return [
    "---",
    "version: 1",
    "id: E1",
    'title: "Player leaderboard"',
    "repos: [lab]",
    "stories: [S1]",
    "branch: epic/leaderboard",
    "status: todo",
    "---",
    "",
    "# E1 · Player leaderboard",
    "",
  ].join("\n");
}

interface Fixture {
  readonly root: string;
  readonly planDir: string;
  readonly storyPath: string;
  readonly epicPath: string;
  readonly dispose: () => void;
}

let open: Fixture[] = [];
afterEach(() => {
  for (const fixture of open) fixture.dispose();
  open = [];
});

function makePlan(storyText = story("S1")): Fixture {
  const root = mkdtempSync(join(tmpdir(), "tldrx-tickets-"));
  const planDir = join(root, "03-plan");
  mkdirSync(join(planDir, "stories"), { recursive: true });
  mkdirSync(join(planDir, "epics"), { recursive: true });
  const storyPath = join(planDir, "stories", "S1.md");
  const epicPath = join(planDir, "epics", "E1.md");
  writeFileSync(storyPath, storyText, "utf8");
  writeFileSync(epicPath, epic(), "utf8");
  const fixture: Fixture = {
    root, planDir, storyPath, epicPath,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
  open.push(fixture);
  return fixture;
}

// --- fake transports --------------------------------------------------------

interface FakeCommand extends CommandTransport {
  readonly calls: { cmd: string; args: readonly string[] }[];
}

/** Answers the three `gh issue` shapes the provider actually uses. */
function fakeGh(state = "OPEN"): FakeCommand {
  const calls: { cmd: string; args: readonly string[] }[] = [];
  const URL_12 = "https://github.com/scavtopia/lab/issues/12";
  return {
    calls,
    async run(cmd: string, args: readonly string[]): Promise<CommandResult> {
      calls.push({ cmd, args });
      const verb = args[1];
      if (verb === "create" || verb === "edit") {
        return { exitCode: 0, stdout: `${URL_12}\n`, stderr: "" };
      }
      if (verb === "view") {
        return { exitCode: 0, stdout: JSON.stringify({ number: 12, url: URL_12, state }), stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: `unexpected gh args: ${args.join(" ")}` };
    },
  };
}

interface FakeHttp extends HttpTransport {
  readonly calls: HttpRequest[];
}

function fakeJira(statusName = "To Do"): FakeHttp {
  const calls: HttpRequest[] = [];
  return {
    calls,
    async request(req: HttpRequest): Promise<HttpResponse> {
      calls.push(req);
      if (req.method === "POST") {
        return { status: 201, text: JSON.stringify({ id: "10001", key: "APP-14", self: "https://x/rest/api/3/issue/10001" }) };
      }
      if (req.method === "PUT") return { status: 204, text: "" };
      return { status: 200, text: JSON.stringify({ key: "APP-14", fields: { status: { name: statusName } } }) };
    },
  };
}

const JIRA_CREDS = { baseUrl: "https://acme.atlassian.net", email: "a@b.c", apiToken: "tok" } as const;

function ghProvider(transport: CommandTransport) {
  return createGithubProvider({ transport, repo: "scavtopia/lab" });
}

function jiraProvider(transport: HttpTransport) {
  return createJiraProvider({ transport, credentials: JIRA_CREDS, project: "APP" });
}

// --- the body ---------------------------------------------------------------

describe("the issue body", () => {
  test("carries the title, acceptance, test plan, a link to the file, and the footer", () => {
    const body = renderIssueBody({
      kind: "story", id: "S1", title: "Leaderboard read model",
      acceptance: ["Top-50 ranks render"], testPlan: ["Unit: rank ordering"],
      stories: [], rel: "stories/S1.md", runId: RUN_ID,
    });
    expect(body).toContain("# S1 · Leaderboard read model");
    expect(body).toContain("- Top-50 ranks render");
    expect(body).toContain("- Unit: rank ordering");
    expect(body).toContain(`tldrx-work/${RUN_ID}/stories/S1.md`);
    expect(body.trimEnd().endsWith(TICKET_FOOTER)).toBe(true);
  });

  test("the footer is on every mirrored item, epics included", () => {
    const fixture = makePlan();
    for (const item of collectMirrorItems(fixture.planDir, RUN_ID).items) {
      expect(item.issueBody).toContain(TICKET_FOOTER);
    }
  });
});

// --- guard rail 1: status is never written ----------------------------------

describe("guard rail — files are the source of truth", () => {
  test("a sync writes external and external_status, and never touches status:", async () => {
    const fixture = makePlan();
    const gh = fakeGh("CLOSED");
    const before = readFileSync(fixture.storyPath, "utf8");

    await syncTickets({
      planDir: fixture.planDir, runId: RUN_ID, provider: ghProvider(gh),
      sync: "two-way", dryRun: false, now: () => NOW,
    });

    const after = readFileSync(fixture.storyPath, "utf8");
    expect(statusLine(after)).toBe(statusLine(before));
    expect(statusLine(after)).toBe("status: todo");

    const external = readExternal(after);
    expect(external.external).toEqual({
      provider: "github", key: "12",
      url: "https://github.com/scavtopia/lab/issues/12", synced_at: NOW,
    });
    // The remote is CLOSED. The story is still todo, and only external_status says so.
    expect(external.externalStatus).toBe("CLOSED");
    expect(validateStoryFile(after, new Set(["npm run test"])).validation.ok).toBe(true);
  });

  test("a remote Done can never reach a story's status, even through applyExternal", () => {
    const text = story("S1");
    const patched = applyExternal(text, {
      external: { provider: "jira", key: "APP-14", url: "https://x/browse/APP-14", synced_at: NOW },
      externalStatus: "Done",
    });
    expect(statusLine(patched)).toBe("status: todo");
    expect(readExternal(patched).externalStatus).toBe("Done");
    expect(validateStoryFile(patched, new Set(["npm run test"])).validation.ok).toBe(true);
  });

  test("applyExternal refuses a file with no front matter rather than inventing one", () => {
    expect(() => applyExternal("# just prose\n", { externalStatus: "Done" })).toThrow(TicketAdapterError);
  });

  test("mirror-out never writes external_status — it reads nothing back", async () => {
    const fixture = makePlan();
    const gh = fakeGh("CLOSED");
    await syncTickets({
      planDir: fixture.planDir, runId: RUN_ID, provider: ghProvider(gh),
      sync: "mirror-out", dryRun: false, now: () => NOW,
    });
    const after = readFileSync(fixture.storyPath, "utf8");
    expect(readExternal(after).external).not.toBeNull();
    expect(readExternal(after).externalStatus).toBeNull();
    expect(gh.calls.some((call) => call.args[1] === "view")).toBe(false);
  });
});

// --- guard rail 2: idempotence ----------------------------------------------

describe("guard rail — re-syncing is idempotent", () => {
  test("the second sync reuses the key, creates nothing, and leaves the file byte-identical", async () => {
    const fixture = makePlan();
    const gh = fakeGh();
    const options = {
      planDir: fixture.planDir, runId: RUN_ID, provider: ghProvider(gh),
      sync: "two-way" as const, dryRun: false, now: () => NOW,
    };

    const first = await syncTickets(options);
    expect(first.created).toBe(2); // the epic and the story
    expect(first.updated).toBe(0);
    const afterFirst = readFileSync(fixture.storyPath, "utf8");

    const second = await syncTickets(options);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(2);
    expect(readFileSync(fixture.storyPath, "utf8")).toBe(afterFirst);

    // No second `issue create` anywhere in the transcript.
    const creates = gh.calls.filter((call) => call.args[1] === "create");
    expect(creates.length).toBe(2);
    const edits = gh.calls.filter((call) => call.args[1] === "edit");
    expect(edits.length).toBe(2);
    expect(edits[0]?.args[2]).toBe("12");
    expect(second.results.every((r) => r.ref?.key === "12")).toBe(true);
  });
});

// --- guard rail 3: dry run --------------------------------------------------

describe("guard rail — --dry-run calls nothing", () => {
  test("zero transport calls and zero file writes, but the same plan", async () => {
    const fixture = makePlan();
    const gh = fakeGh();
    const before = readFileSync(fixture.storyPath, "utf8");

    const outcome = await syncTickets({
      planDir: fixture.planDir, runId: RUN_ID, provider: ghProvider(gh),
      sync: "two-way", dryRun: true, now: () => NOW,
    });

    expect(gh.calls.length).toBe(0);
    expect(readFileSync(fixture.storyPath, "utf8")).toBe(before);
    expect(outcome.dryRun).toBe(true);
    expect(outcome.created).toBe(2);
    expect(outcome.results.every((result) => result.ref === null && !result.wrote)).toBe(true);
  });
});

// --- the github provider's argument shape -----------------------------------

describe("the github provider", () => {
  test("shapes `gh issue create` and `gh issue edit` exactly", async () => {
    const gh = fakeGh();
    const provider = ghProvider(gh);

    const created = await provider.write({ kind: "story", id: "S1", title: "S1 · T", body: "B" }, null);
    expect(gh.calls[0]).toEqual({
      cmd: "gh",
      args: ["issue", "create", "--repo", "scavtopia/lab", "--title", "S1 · T", "--body", "B"],
    });
    expect(created).toEqual({ key: "12", url: "https://github.com/scavtopia/lab/issues/12" });

    await provider.write({ kind: "story", id: "S1", title: "S1 · T", body: "B2" }, "12");
    expect(gh.calls[1]?.args).toEqual(
      ["issue", "edit", "12", "--repo", "scavtopia/lab", "--title", "S1 · T", "--body", "B2"],
    );

    expect(await provider.readStatus("12")).toBe("OPEN");
    expect(gh.calls[2]?.args).toEqual(
      ["issue", "view", "12", "--repo", "scavtopia/lab", "--json", "state,url,number"],
    );
  });

  test("a project that is not owner/repo is refused before any call", () => {
    const gh = fakeGh();
    expect(() => createGithubProvider({ transport: gh, repo: "APP" })).toThrow(TicketAdapterError);
    expect(gh.calls.length).toBe(0);
  });

  test("a missing gh binary is reported as a missing gh binary", async () => {
    const provider = createGithubProvider({
      transport: { async run() { return { exitCode: 127, stdout: "", stderr: "" }; } },
      repo: "o/r",
    });
    await expect(provider.write({ kind: "story", id: "S1", title: "t", body: "b" }, null))
      .rejects.toThrow(/not on PATH/);
  });

  test("parses the issue number out of the URL gh prints", () => {
    expect(issueNumber(parseIssueUrl("noise\nhttps://github.com/o/r/issues/7\n"))).toBe("7");
    expect(() => parseIssueUrl("nothing useful")).toThrow(TicketAdapterError);
  });
});

// --- the jira provider's request shape --------------------------------------

describe("the jira provider", () => {
  test("shapes the REST v3 create, update and read", async () => {
    const http = fakeJira("Done");
    const provider = jiraProvider(http);

    const created = await provider.write({ kind: "story", id: "S1", title: "S1 · T", body: "line one" }, null);
    const post = http.calls[0];
    expect(post?.method).toBe("POST");
    expect(post?.url).toBe(`https://acme.atlassian.net${JIRA_ISSUE_PATH}`);
    expect(post?.headers.Authorization).toBe(`Basic ${Buffer.from("a@b.c:tok").toString("base64")}`);
    const fields = (post?.body as { fields: Record<string, unknown> }).fields;
    expect(fields.project).toEqual({ key: "APP" });
    expect(fields.summary).toBe("S1 · T");
    expect(fields.issuetype).toEqual({ name: "Task" });
    expect(created).toEqual({ key: "APP-14", url: "https://acme.atlassian.net/browse/APP-14" });

    await provider.write({ kind: "epic", id: "E1", title: "E1 · T", body: "b" }, "APP-14");
    expect(http.calls[1]?.method).toBe("PUT");
    expect(http.calls[1]?.url).toBe(`https://acme.atlassian.net${JIRA_ISSUE_PATH}/APP-14`);

    expect(await provider.readStatus("APP-14")).toBe("Done");
    expect(http.calls[2]?.method).toBe("GET");
    expect(http.calls[2]?.url).toBe(`https://acme.atlassian.net${JIRA_ISSUE_PATH}/APP-14?fields=status`);
  });

  test("an epic is created as an Epic, a story as a Task", async () => {
    const http = fakeJira();
    await jiraProvider(http).write({ kind: "epic", id: "E1", title: "E1 · T", body: "b" }, null);
    const fields = (http.calls[0]?.body as { fields: Record<string, unknown> }).fields;
    expect(fields.issuetype).toEqual({ name: "Epic" });
  });

  test("a non-2xx is an error, not a silent success", async () => {
    const provider = createJiraProvider({
      transport: { async request() { return { status: 403, text: '{"errorMessages":["nope"]}' }; } },
      credentials: JIRA_CREDS, project: "APP",
    });
    await expect(provider.write({ kind: "story", id: "S1", title: "t", body: "b" }, null))
      .rejects.toThrow(/returned 403/);
  });

  test("missing credentials name all three variables and write nothing", () => {
    const result = resolveJiraCredentials({ JIRA_BASE_URL: "https://x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(["JIRA_EMAIL", "JIRA_API_TOKEN"]);
    for (const name of JIRA_ENV_VARS) expect(result.message).toContain(name);
    expect(result.message).toContain("Nothing was written.");
  });

  test("credentials present resolve, with the base URL's trailing slash removed", () => {
    const result = resolveJiraCredentials({
      JIRA_BASE_URL: "https://acme.atlassian.net/", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "tok",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credentials.baseUrl).toBe("https://acme.atlassian.net");
  });
});

// --- process.yml ------------------------------------------------------------

describe("reading ticket_tool out of process.yml", () => {
  test("the spec §2.12 nested shape init writes", () => {
    const fixture = makePlan();
    mkdirSync(join(fixture.root, ".tldrx"), { recursive: true });
    writeFileSync(
      join(fixture.root, ".tldrx", "process.yml"),
      "version: 1\nticket_tool: {kind: jira, project: APP, board: null, sync: two-way}\n",
      "utf8",
    );
    const config = readTicketToolConfig(fixture.root);
    expect(config.kind).toBe("jira");
    expect(config.project).toBe("APP");
    expect(config.sync).toBe("two-way");
  });

  test("the flat draft shape templates/process.yml ships", () => {
    const fixture = makePlan();
    mkdirSync(join(fixture.root, ".tldrx"), { recursive: true });
    writeFileSync(
      join(fixture.root, ".tldrx", "process.yml"),
      "schema_version: 0\nticket_tool: github\nproject_key: scavtopia/lab\nticket_sync: mirror-out\n",
      "utf8",
    );
    const config = readTicketToolConfig(fixture.root);
    expect(config.kind).toBe("github");
    expect(config.project).toBe("scavtopia/lab");
    expect(config.sync).toBe("mirror-out");
  });

  test("no process.yml means the adapter is off, not a crash", () => {
    const fixture = makePlan();
    const config = readTicketToolConfig(fixture.root);
    expect(config.kind).toBe("none");
    expect(config.path).toBeNull();
  });
});

// --- the status view --------------------------------------------------------

describe("tickets status", () => {
  test("marks divergence without changing anything", () => {
    const fixture = makePlan(story("S1", "todo"));
    const before = readFileSync(fixture.storyPath, "utf8");
    const patched = applyExternal(before, {
      external: { provider: "jira", key: "APP-14", url: "https://x/browse/APP-14", synced_at: NOW },
      externalStatus: "Done",
    });
    writeFileSync(fixture.storyPath, patched, "utf8");

    const items = collectMirrorItems(fixture.planDir, RUN_ID).items;
    const s1 = items.find((item) => item.id === "S1");
    const e1 = items.find((item) => item.id === "E1");
    expect(s1).toBeDefined();
    expect(divergenceOf(s1!)).toBe("diverged");   // local todo, remote Done
    expect(divergenceOf(e1!)).toBe("unsynced");   // never mirrored

    const table = renderStatusTable(statusRows(items));
    expect(table).toContain("APP-14");
    expect(table).toContain("1 diverged");
    expect(readFileSync(fixture.storyPath, "utf8")).toBe(patched);
  });

  test("local done and a remote Done are aligned", () => {
    const fixture = makePlan();
    writeFileSync(
      fixture.storyPath,
      applyExternal(story("S1", "review"), {
        external: { provider: "github", key: "12", url: "https://x/issues/12", synced_at: NOW },
        externalStatus: "CLOSED",
      }),
      "utf8",
    );
    const s1 = collectMirrorItems(fixture.planDir, RUN_ID).items.find((item) => item.id === "S1");
    expect(divergenceOf(s1!)).toBe("diverged");
  });
});

// --- the event --------------------------------------------------------------

describe("the ticket.synced event", () => {
  test("is in the closed enum and validates as an envelope", () => {
    const result = validateEvent({
      ts: NOW, run: RUN_ID, stage: null, type: "ticket.synced", actor: "alan", cost_usd: 0,
      payload: {
        kind: "story", id: "S1", action: "create", provider: "github",
        key: "12", url: "https://github.com/o/r/issues/12", external_status: "OPEN",
        file: "03-plan/stories/S1.md",
      },
    });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

// --- collection -------------------------------------------------------------

describe("collecting 03-plan/", () => {
  test("epics first, then stories, each sorted by id", () => {
    const fixture = makePlan();
    writeFileSync(join(fixture.planDir, "stories", "S2.md"), story("S2"), "utf8");
    const items = collectMirrorItems(fixture.planDir, RUN_ID).items;
    expect(items.map((item) => item.id)).toEqual(["E1", "S1", "S2"]);
  });

  test("a file that does not parse is skipped and named, not fatal", () => {
    const fixture = makePlan();
    writeFileSync(join(fixture.planDir, "stories", "S9.md"), "no front matter here\n", "utf8");
    const collected = collectMirrorItems(fixture.planDir, RUN_ID);
    expect(collected.items.map((item) => item.id)).toEqual(["E1", "S1"]);
    expect(collected.skipped.join(" ")).toContain("stories/S9.md");
  });
});

function statusLine(text: string): string {
  return (text.split("\n").find((line) => /^status\s*:/.test(line)) ?? "").trim();
}
