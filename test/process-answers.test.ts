/**
 * The install interview's two process answers, and what they do to
 * `.tldrx/process.yml`.
 *
 * The bug these tests pin: the answers used to land in `facts.yml` and nowhere
 * else, so `tldrx tickets` kept reading `kind: none` after a human had said
 * "GitHub". Every assertion below is about the FILE, not about the fact — the fact
 * was never the thing that was broken.
 *
 * No `claude` and no network: the only child process is `git`, and it is a fake
 * `CommandRunner` in every test here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseYaml, stringifyYaml } from "../src/core/yaml.ts";
import { readTicketToolConfig } from "../src/core/adapters/processConfig.ts";
import {
  METHODOLOGY_CHOICES, METHODOLOGY_QUESTION, TICKET_CHOICES, TICKET_QUESTION, planQuestions,
} from "../src/core/init/questions.ts";
import { buildProcessDocument, PROCESS_HEADER } from "../src/core/init/processDocument.ts";
import { endWithNewline } from "../src/core/init/writeFile.ts";
import { parseGithubRemote, resolveGithubProject } from "../src/core/init/githubProject.ts";
import {
  applyProcessAnswers, collectProcessAnswers, matchChoice, patchProcessFile, renderProcessApply,
} from "../src/core/init/processAnswers.ts";
import { initQuestionsFile } from "./fixtures/initQuestions.ts";
import { WORKSPACE_YML } from "./fixtures/tempRunWorkspace.ts";
import type { CommandResult, CommandRunner } from "../src/core/detect/CommandRunner.ts";
import type { DetectedWorkspace } from "../src/core/detect/types.ts";

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop() ?? "", { recursive: true, force: true });
});

/** `git config user.name` always answers; `git remote get-url origin` only where `remotes` says. */
function fakeGit(remotes: Readonly<Record<string, string>> = {}): CommandRunner {
  return {
    run(argv: readonly string[], cwd: string): Promise<CommandResult> {
      const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
      if (argv[1] === "config") return Promise.resolve(ok("alan\n"));
      const url = remotes[cwd];
      return Promise.resolve(
        url === undefined
          ? { exitCode: 128, stdout: "", stderr: "fatal: No such remote 'origin'\n" }
          : ok(`${url}\n`),
      );
    },
  };
}

/** A workspace whose `process.yml` is exactly what `tldrx init` writes. */
function workspace(options: { process?: string | null } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "tldrx-process-"));
  temps.push(root);
  mkdirSync(join(root, ".tldrx", "memory"), { recursive: true });
  mkdirSync(join(root, "api"), { recursive: true });
  mkdirSync(join(root, "lab"), { recursive: true });
  writeFileSync(join(root, ".tldrx", "workspace.yml"), WORKSPACE_YML, "utf8");
  const content = options.process === undefined ? initProcessYml() : options.process;
  if (content !== null) writeFileSync(join(root, ".tldrx", "process.yml"), content, "utf8");
  return root;
}

/** Byte-for-byte what `WriteLog.createIfAbsent` puts on disk, trailing newline included. */
function initProcessYml(): string {
  return endWithNewline(PROCESS_HEADER + stringifyYaml(buildProcessDocument({
    methodology: null, approver: "alan", when: "2026-08-29T09:00:00Z", questionId: "Q1",
  })));
}

function processYml(root: string): string {
  return readFileSync(join(root, ".tldrx", "process.yml"), "utf8");
}

const label = {
  none: "None — a plain ordered list of stories",
  scrum: "Scrum — fixed-length sprints",
  kanban: "Kanban — continuous flow with a WIP limit",
  shapeUp: "Shape Up — appetite-driven cycles",
  ticketNone: "None — files are the only record",
  jira: "Jira — write the project key below",
  github: "GitHub Issues",
  linear: "Linear",
  other: "other — write it below",
} as const;

// --- A2: the ordering ---------------------------------------------------------

describe("the two process questions", () => {
  const detected: DetectedWorkspace = {
    mode: "single-repo",
    rootIsRepo: true,
    root: "/tmp/x",
    evidence: [],
    repos: [{
      name: "api", path: ".", absPath: "/tmp/x", defaultBranch: "main",
      stack: ["typescript"], languages: ["typescript"], packageManager: "npm",
      manifests: ["package.json"], codeFiles: 3,
      commands: { build: "npm run build", test: null, lint: null, typecheck: null, run: null },
      ci: [], confidence: "high", evidence: [],
    }],
  };

  const asked = planQuestions({ workspace: detected, processGiven: false, mcpServers: [] })
    .filter((question) => question.area === "process");

  test("`None` is option A and `other` is last, for both", () => {
    expect(asked.map((question) => question.question)).toEqual([METHODOLOGY_QUESTION, TICKET_QUESTION]);
    expect(asked[0]?.options[0]).toBe(label.none);
    expect(asked[1]?.options[0]).toBe(label.ticketNone);
    for (const question of asked) expect(question.options.at(-1)).toBe(label.other);
  });

  test("an MCP suggestion annotates its option and never reorders them", () => {
    const [, ticket] = planQuestions({
      workspace: detected,
      processGiven: false,
      mcpServers: [{ name: "atlassian", transport: "http", status: "connected" }],
    }).filter((question) => question.area === "process");
    expect(ticket?.options[0]).toBe(label.ticketNone);
    expect(ticket?.options[1]).toBe(`${label.jira} (MCP server connected)`);
  });
});

// --- A1: option -> value ------------------------------------------------------

describe("an offered option maps to a process.yml value", () => {
  test("every methodology label", () => {
    expect(matchChoice(label.none, METHODOLOGY_CHOICES)).toBe("none");
    expect(matchChoice(label.scrum, METHODOLOGY_CHOICES)).toBe("scrum");
    expect(matchChoice(label.kanban, METHODOLOGY_CHOICES)).toBe("kanban");
    expect(matchChoice(label.shapeUp, METHODOLOGY_CHOICES)).toBe("shape-up");
  });

  test("every ticket-tool label, with or without the MCP suffix", () => {
    expect(matchChoice(label.ticketNone, TICKET_CHOICES)).toBe("none");
    expect(matchChoice(label.jira, TICKET_CHOICES)).toBe("jira");
    expect(matchChoice(`${label.jira} (MCP server connected)`, TICKET_CHOICES)).toBe("jira");
    expect(matchChoice(label.github, TICKET_CHOICES)).toBe("github");
    expect(matchChoice(`${label.github} (MCP server connected)`, TICKET_CHOICES)).toBe("github");
    expect(matchChoice(label.linear, TICKET_CHOICES)).toBe("linear");
  });

  test("`other` and free text map to nothing — a value is never inferred from prose", () => {
    expect(matchChoice(label.other, METHODOLOGY_CHOICES)).toBeNull();
    expect(matchChoice("we do two-week cycles, sort of scrum", METHODOLOGY_CHOICES)).toBeNull();
    expect(matchChoice("kanban", METHODOLOGY_CHOICES)).toBeNull();
    expect(matchChoice("we file in Jira", TICKET_CHOICES)).toBeNull();
  });
});

// --- A1: the github project ---------------------------------------------------

describe("parseGithubRemote", () => {
  test("https, with and without .git and a trailing slash", () => {
    expect(parseGithubRemote("https://github.com/ederwii/aparece-api")).toBe("ederwii/aparece-api");
    expect(parseGithubRemote("https://github.com/ederwii/aparece-api.git")).toBe("ederwii/aparece-api");
    expect(parseGithubRemote("https://github.com/ederwii/aparece-api/")).toBe("ederwii/aparece-api");
    expect(parseGithubRemote("https://alan@github.com/ederwii/aparece-api.git")).toBe("ederwii/aparece-api");
  });

  test("ssh, scp-style and ssh:// alike", () => {
    expect(parseGithubRemote("git@github.com:ederwii/aparece-api.git")).toBe("ederwii/aparece-api");
    expect(parseGithubRemote("git@github.com:ederwii/aparece-api")).toBe("ederwii/aparece-api");
    expect(parseGithubRemote("ssh://git@github.com/ederwii/aparece-api.git")).toBe("ederwii/aparece-api");
  });

  test("anything that is not a github `owner/repo` is null, not half-parsed", () => {
    expect(parseGithubRemote("https://gitlab.com/ederwii/aparece-api.git")).toBeNull();
    expect(parseGithubRemote("git@bitbucket.org:ederwii/aparece-api.git")).toBeNull();
    expect(parseGithubRemote("https://github.example.com/o/r.git")).toBeNull();
    expect(parseGithubRemote("/Users/alan/src/aparece-api")).toBeNull();
    expect(parseGithubRemote("https://github.com/ederwii")).toBeNull();
    expect(parseGithubRemote("")).toBeNull();
  });
});

describe("resolveGithubProject", () => {
  test("the workspace root's own remote wins", async () => {
    const root = workspace();
    const found = await resolveGithubProject(root, fakeGit({ [root]: "git@github.com:o/root-repo.git" }));
    expect(found).toEqual({ project: "o/root-repo", from: ".", rejected: [] });
  });

  test("otherwise the first workspace.yml repo with a github remote, in file order", async () => {
    const root = workspace();
    const found = await resolveGithubProject(root, fakeGit({
      [join(root, "api")]: "https://gitlab.com/o/api.git",
      [join(root, "lab")]: "https://github.com/o/lab.git",
    }));
    expect(found.project).toBe("o/lab");
    expect(found.from).toBe("lab");
    expect(found.rejected).toEqual(["https://gitlab.com/o/api.git"]);
  });

  test("no github remote anywhere is null, and says what it read", async () => {
    const root = workspace();
    const found = await resolveGithubProject(root, fakeGit({ [root]: "https://gitlab.com/o/r.git" }));
    expect(found.project).toBeNull();
    expect(found.rejected).toEqual(["https://gitlab.com/o/r.git"]);
  });
});

// --- A1: applying ------------------------------------------------------------

const answers = (methodology: string | null, ticketTool: string | null) =>
  ({ methodology, ticketTool, questionId: "Q1" });

describe("applyProcessAnswers", () => {
  test("methodology lands in the file, with the cadence key it makes required", async () => {
    for (const [text, value, cadence] of [
      [label.scrum, "scrum", { sprint_length_days: 14 }],
      [label.kanban, "kanban", { wip_limit: 3 }],
      [label.shapeUp, "shape-up", {}],
      [label.none, "none", {}],
    ] as const) {
      const root = workspace();
      const result = await applyProcessAnswers({
        root, answers: answers(text, null), runner: fakeGit(), when: "2026-08-29T10:00:00Z",
      });
      expect(result.methodology).toBe(value);
      const document = parseYaml(processYml(root)) as Record<string, unknown>;
      expect(document.methodology).toBe(value);
      for (const [key, expected] of Object.entries(cadence)) {
        expect((document.cadence as Record<string, unknown>)[key]).toBe(expected as never);
      }
      // `none` is already what init wrote, so nothing was rewritten for it.
      expect(result.changed).toBe(value !== "none");
    }
  });

  test("github writes kind AND the owner/repo the remote actually says", async () => {
    const root = workspace();
    const result = await applyProcessAnswers({
      root,
      answers: answers(null, label.github),
      runner: fakeGit({ [root]: "https://github.com/ederwii/aparece-api.git" }),
      when: "2026-08-29T10:00:00Z",
    });
    expect(result).toMatchObject({ changed: true, ticketTool: "github", project: "ederwii/aparece-api" });
    expect(result.notes).toEqual([]);
    // The assertion that matters: the command that reads this file sees it.
    expect(readTicketToolConfig(root)).toMatchObject({ kind: "github", project: "ederwii/aparece-api" });
    expect(renderProcessApply(result)).toBe("process.yml: ticket_tool=github (ederwii/aparece-api)\n");
  });

  test("github with no github remote sets kind, leaves project, and says so", async () => {
    const root = workspace();
    const result = await applyProcessAnswers({
      root,
      answers: answers(null, label.github),
      runner: fakeGit({ [root]: "https://gitlab.com/o/r.git" }),
      when: "2026-08-29T10:00:00Z",
    });
    expect(result.project).toBeNull();
    expect(readTicketToolConfig(root)).toMatchObject({ kind: "github", project: null });
    expect(result.notes.join("\n")).toContain("set ticket_tool.project (`owner/repo`)");
    expect(result.notes.join("\n")).toContain("https://gitlab.com/o/r.git");
  });

  test("jira sets kind, never invents a project key, and names the key to set", async () => {
    const root = workspace();
    const result = await applyProcessAnswers({
      root, answers: answers(null, label.jira), runner: fakeGit(), when: "2026-08-29T10:00:00Z",
    });
    expect(readTicketToolConfig(root)).toMatchObject({ kind: "jira", project: null });
    expect(result.notes).toEqual(["set ticket_tool.project (Jira project key) in .tldrx/process.yml"]);
  });

  test("linear sets kind and warns that this build has no adapter", async () => {
    const root = workspace();
    const result = await applyProcessAnswers({
      root, answers: answers(null, label.linear), runner: fakeGit(), when: "2026-08-29T10:00:00Z",
    });
    expect(readTicketToolConfig(root).kind).toBe("linear");
    expect(result.notes.join("\n")).toContain("no adapter in this build");
  });

  test("free text leaves the file byte-identical and prints the note", async () => {
    const root = workspace();
    const before = processYml(root);
    const result = await applyProcessAnswers({
      root,
      answers: answers("we run six-week cycles", "our own spreadsheet"),
      runner: fakeGit(),
      when: "2026-08-29T10:00:00Z",
    });
    expect(result.changed).toBe(false);
    expect(processYml(root)).toBe(before);
    const printed = renderProcessApply(result);
    expect(printed).toContain("process.yml: unchanged");
    expect(printed).toContain("Set `methodology:` in .tldrx/process.yml by hand");
    expect(printed).toContain("Set `ticket_tool.kind:` in .tldrx/process.yml by hand");
  });

  test("everything else in the file survives — cadence, approvers, dod, source, key order", async () => {
    const root = workspace();
    const before = processYml(root);
    await applyProcessAnswers({
      root,
      answers: answers(label.scrum, label.github),
      runner: fakeGit({ [root]: "git@github.com:o/r.git" }),
      when: "2026-08-29T10:00:00Z",
    });
    const after = processYml(root);
    expect(after.startsWith(PROCESS_HEADER)).toBe(true);
    const document = parseYaml(after) as Record<string, unknown>;
    expect(document.approvers).toEqual(["alan"]);
    expect(document.source).toEqual({ who: "tldrx-init", when: "2026-08-29T09:00:00Z", run: "init", q: "Q1" });
    expect(document.dod).toEqual({ add: [], remove: [] });
    expect(document.story_granularity).toBe("days");
    const keys = (text: string) =>
      text.split("\n").flatMap((line) => /^([a-z_]+):/.exec(line)?.[1] ?? []);
    expect(keys(after)).toEqual(keys(before));
  });

  test("a second run over the same answers writes nothing and is byte-identical", async () => {
    const root = workspace();
    const input = {
      root,
      answers: answers(label.kanban, label.github),
      runner: fakeGit({ [root]: "git@github.com:o/r.git" }),
      when: "2026-08-29T10:00:00Z",
    };
    const first = await applyProcessAnswers(input);
    expect(first.changed).toBe(true);
    const afterFirst = processYml(root);

    const second = await applyProcessAnswers(input);
    expect(second.changed).toBe(false);
    expect(second.created).toBe(false);
    expect(processYml(root)).toBe(afterFirst);
    expect(renderProcessApply(second)).toBe("process.yml: unchanged\n");
  });

  test("a missing process.yml is created, with the answers already applied", async () => {
    const root = workspace({ process: null });
    const result = await applyProcessAnswers({
      root,
      answers: answers(label.scrum, label.github),
      runner: fakeGit({ [root]: "git@github.com:o/r.git" }),
      when: "2026-08-29T10:00:00Z",
    });
    expect(result).toMatchObject({ changed: true, created: true, methodology: "scrum", project: "o/r" });
    const text = processYml(root);
    expect(text.startsWith(PROCESS_HEADER)).toBe(true);
    const document = parseYaml(text) as Record<string, unknown>;
    expect(document.methodology).toBe("scrum");
    expect((document.cadence as Record<string, unknown>).sprint_length_days).toBe(14);
    // `approvers` is non-empty (spec §2.12) — read from the same git seam init uses.
    expect(document.approvers).toEqual(["alan"]);
    expect(readTicketToolConfig(root)).toMatchObject({ kind: "github", project: "o/r" });
    expect(renderProcessApply(result))
      .toBe("process.yml (created): methodology=scrum, ticket_tool=github (o/r)\n");
  });

  test("the flat draft shape keeps being flat", async () => {
    const root = workspace({
      process: "# a hand-written file\nschema_version: 0\nmethodology: none\nticket_tool: none\nproject_key: null\n",
    });
    await applyProcessAnswers({
      root,
      answers: answers(label.kanban, label.github),
      runner: fakeGit({ [root]: "git@github.com:o/r.git" }),
      when: "2026-08-29T10:00:00Z",
    });
    const text = processYml(root);
    expect(text.startsWith("# a hand-written file\n")).toBe(true);
    expect(text).toContain("ticket_tool: github");
    expect(text).toContain("project_key: o/r");
    expect(readTicketToolConfig(root)).toMatchObject({ kind: "github", project: "o/r" });
  });

  test("a process.yml that is not a YAML mapping is returned untouched", () => {
    const patched = patchProcessFile("- not\n- a mapping\n", {
      methodology: "scrum", ticketTool: "github", project: "o/r",
    });
    expect(patched).toBe("- not\n- a mapping\n");
  });
});

describe("collectProcessAnswers", () => {
  test("attributes each answer by question title, `other` included", () => {
    const root = workspace();
    const path = join(root, ".tldrx", "init-questions.md");
    writeFileSync(path, initQuestionsFile(), "utf8");
    const collected = collectProcessAnswers(path, [
      { q: "Q2", fact: "F002", answer: label.github, area: "process" },
      { q: "Q1", fact: "F001", answer: "six-week cycles", area: "process" },
    ]);
    expect(collected).toEqual({
      methodology: "six-week cycles", ticketTool: label.github, questionId: "Q1",
    });
  });

  test("nothing answered is nothing to apply", () => {
    const root = workspace();
    const path = join(root, ".tldrx", "init-questions.md");
    writeFileSync(path, initQuestionsFile(), "utf8");
    expect(collectProcessAnswers(path, [])).toEqual({
      methodology: null, ticketTool: null, questionId: null,
    });
  });
});
