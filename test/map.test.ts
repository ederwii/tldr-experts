import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { detectWorkspace, SpawnCommandRunner } from "../src/core/detect/index.ts";
import {
  buildMap, checkCitations, endsWithToken, isBullet, parseChurn, parseSrc, parseToken,
  renderMapDoc, srcToken, summariseGraph, GraphifyProvider, StaticProvider, MAP_DOCS,
  type MapContext,
} from "../src/core/map/index.ts";
import { fakeRunner, multiRepoFixture, okResult, singleRepoFixture, type Fixture } from "./init-fixture.ts";

const runner = new SpawnCommandRunner();

describe("the src token grammar (spec §2.8)", () => {
  test("every production parses", () => {
    expect(parseSrc("api:src/Hunt.cs:184")?.kind).toBe("file");
    expect(parseSrc("src/index.ts:1-20")?.kind).toBe("file");
    expect(parseSrc("https://example.com/docs")?.kind).toBe("doc");
    expect(parseSrc("Q4")?.kind).toBe("ans");
    expect(parseSrc("F019")?.kind).toBe("fact");
    expect(parseSrc("$ dotnet build → exit 0")?.kind).toBe("cmd");
    expect(parseSrc("graph:pkg_mod_a")?.kind).toBe("graph");
    expect(parseSrc("absent:.tldrx/memory/facts.yml")?.kind).toBe("absent");
  });

  test("what the grammar rejects", () => {
    expect(parseSrc("http://example.com")).toBeNull(); // https only
    expect(parseSrc("src/index.ts")).toBeNull(); // no line number
    expect(parseSrc("F1")).toBeNull(); // fact ids are 3-6 digits
    expect(parseSrc("just some prose")).toBeNull();
  });

  test("a file src keeps its repo, path and line range", () => {
    const parsed = parseSrc("lab:src/a.ts:10-12");
    expect(parsed).toEqual({ kind: "file", raw: "lab:src/a.ts:10-12", repo: "lab", path: "src/a.ts", line: 10, endLine: 12 });
  });

  test("a bullet must END with its token, and multiple srcs are separated by `; `", () => {
    expect(endsWithToken(`- claim ${srcToken(["lab:src/a.ts:1", "$ git log → exit 0"])}`)).toBe(true);
    expect(endsWithToken("- claim [src: lab:src/a.ts:1] and then more prose")).toBe(false);
    expect(endsWithToken("- claim with no source at all")).toBe(false);
    expect(parseToken("- x [src: Q4; F001]").length).toBe(2);
  });

  test("bullets are recognised, headings are not", () => {
    expect(isBullet("- a claim")).toBe(true);
    expect(isBullet("  - nested claim")).toBe(true);
    expect(isBullet("> a quote")).toBe(false);
    expect(isBullet("# Heading")).toBe(false);
  });
});

describe("git churn parsing", () => {
  test("numstat rows accumulate per file, subjects are kept for the gotchas pass", () => {
    const report = parseChurn([
      "fix: a bug",
      "3\t1\tsrc/a.ts",
      "1\t0\tsrc/b.ts",
      "feat: a feature",
      "10\t2\tsrc/a.ts",
    ].join("\n"));

    expect(report.ok).toBe(true);
    expect(report.commitCount).toBe(2);
    expect(report.subjects).toEqual(["fix: a bug", "feat: a feature"]);
    expect(report.files[0]).toEqual({ path: "src/a.ts", commits: 2, added: 13, deleted: 3 });
    expect(report.files[1]).toEqual({ path: "src/b.ts", commits: 1, added: 1, deleted: 0 });
  });

  test("binary rows (`-`) count as a touch, not as lines", () => {
    const report = parseChurn(["chore: image", "-\t-\tlogo.png"].join("\n"));
    expect(report.files[0]).toEqual({ path: "logo.png", commits: 1, added: 0, deleted: 0 });
  });
});

describe("graph.json", () => {
  // Shape measured from `graphify update <path> --no-cluster` (graphify 0.8.x).
  const graph = {
    nodes: [
      { id: "main", label: "main.py", file_type: "code", source_file: "main.py", source_location: "L1" },
      { id: "pkg_mod", label: "mod.py", file_type: "code", source_file: "pkg/mod.py", source_location: "L1" },
      { id: "lonely", label: "lonely.py" },
    ],
    links: [
      { source: "main", target: "pkg_mod", relation: "imports_from" },
      { source: "main", target: "pkg_mod", relation: "calls" },
    ],
  };

  test("hubs are ranked by degree and keep their file:line", () => {
    const summary = summariseGraph(graph);
    expect(summary?.nodeCount).toBe(3);
    expect(summary?.edgeCount).toBe(2);
    expect(summary?.hubs.map((hub) => hub.id)).toEqual(["main", "pkg_mod"]);
    expect(summary?.hubs[0]?.sourceFile).toBe("main.py");
    expect(summary?.hubs[0]?.sourceLine).toBe(1);
  });

  test("an unrecognised shape degrades to null instead of guessing", () => {
    expect(summariseGraph({ something: "else" })).toBeNull();
    expect(summariseGraph(null)).toBeNull();
    expect(summariseGraph({ nodes: [] })).toBeNull();
  });
});

describe("the static provider", () => {
  let fixture: Fixture;
  let context: MapContext;

  beforeAll(async () => {
    fixture = await multiRepoFixture();
    const workspace = await detectWorkspace(fixture.root, runner);
    const repo = workspace.repos.find((candidate) => candidate.name === "lab");
    if (repo === undefined) throw new Error("fixture repo missing");
    context = { repo, outDir: join(fixture.root, ".tldrx/graphify-out/lab"), root: fixture.root };
  });
  afterAll(async () => { await fixture.cleanup(); });

  test("fills all six documents, and every bullet ends with a valid token", async () => {
    const facts = await new StaticProvider(runner).collect(context);
    expect(facts.provider).toBe("static");
    for (const doc of MAP_DOCS) {
      expect(facts.docs[doc].length).toBeGreaterThan(0);
      for (const line of renderMapDoc(facts, doc).split("\n").filter(isBullet)) {
        expect(endsWithToken(line)).toBe(true);
      }
    }
  });

  test("finds the TODO the fixture planted, with its real line number", async () => {
    const facts = await new StaticProvider(runner).collect(context);
    const todo = facts.docs.gotchas.find((bullet) => bullet.text.startsWith("TODO"));
    expect(todo?.text).toContain("wire the router");
    expect(todo?.srcs[0]).toBe("lab:src/index.ts:1");
  });

  test("domains skip packaging folders: `src/index.ts` is not a domain, `src/features` is", async () => {
    const facts = await new StaticProvider(runner).collect(context);
    expect(facts.domains).toEqual(["src/features"]);
  });
});

describe("the graphify provider", () => {
  let fixture: Fixture;
  let context: MapContext;

  beforeAll(async () => {
    fixture = await multiRepoFixture();
    const workspace = await detectWorkspace(fixture.root, runner);
    const repo = workspace.repos.find((candidate) => candidate.name === "lab");
    if (repo === undefined) throw new Error("fixture repo missing");
    context = { repo, outDir: join(fixture.root, ".tldrx/graphify-out/lab"), root: fixture.root };
  });
  afterAll(async () => { await fixture.cleanup(); });

  test("is unavailable when the binary is not on PATH — and nothing else is run", async () => {
    const stub = fakeRunner(new Map());
    const provider = new GraphifyProvider(stub, new StaticProvider(stub));
    expect(await provider.isAvailable(context)).toBe(false);
    expect(stub.calls).toEqual(["graphify --version"]);
  });

  test("runs only the two documented commands, and merges graph facts into the static map", async () => {
    await Bun.write(join(context.outDir, "graph.json"), JSON.stringify({
      nodes: [{ id: "lab_src_index", label: "index.ts", source_file: "src/index.ts", source_location: "L1" }],
      links: [{ source: "lab_src_index", target: "lab_src_index", relation: "contains" }],
    }));
    const stub = fakeRunner(new Map([
      ["graphify --version", okResult("0.8.37\n")],
      ["graphify update", okResult("Code graph updated.\n")],
      ["git log", okResult("")],
    ]));
    const provider = new GraphifyProvider(stub, new StaticProvider(stub));

    expect(await provider.isAvailable(context)).toBe(true);
    const facts = await provider.collect(context);

    expect(facts.provider).toBe("graphify");
    expect(stub.calls).toContain(`graphify update ${context.repo.absPath} --no-cluster`);
    for (const call of stub.calls) expect(call.startsWith("graphify") || call.startsWith("git")).toBe(true);

    const hub = facts.docs.architecture.find((bullet) => bullet.text.includes("is a hub"));
    expect(hub?.srcs).toEqual(["lab:src/index.ts:1", "graph:lab_src_index"]);
    for (const doc of MAP_DOCS) {
      for (const line of renderMapDoc(facts, doc).split("\n").filter(isBullet)) {
        expect(endsWithToken(line)).toBe(true);
      }
    }
  });

  test("a graphify-out the user already had is reused and left where it is", async () => {
    const repoOut = join(context.repo.absPath, "graphify-out");
    await Bun.write(join(repoOut, "graph.json"), JSON.stringify({
      nodes: [{ id: "kept", label: "kept.ts", source_file: "src/index.ts", source_location: "L1" }],
      links: [{ source: "kept", target: "kept", relation: "contains" }],
    }));
    const stub = fakeRunner(new Map([
      ["graphify --version", okResult("0.8.37\n")],
      ["graphify update", okResult("")],
      ["git log", okResult("")],
    ]));

    const facts = await new GraphifyProvider(stub, new StaticProvider(stub)).collect(context);

    expect(facts.provider).toBe("graphify");
    expect(await Bun.file(join(repoOut, "graph.json")).exists()).toBe(true);
    await rm(repoOut, { recursive: true, force: true });
  });

  test("a graphify-out this run created is removed again: sibling repos stay untouched", async () => {
    const repoOut = join(context.repo.absPath, "graphify-out");
    const stub = fakeRunner(new Map([
      ["graphify --version", okResult("0.8.37\n")],
      // The real binary writes the graph; the fake stands in for it.
      ["graphify update", okResult("")],
      ["git log", okResult("")],
    ]));
    await new GraphifyProvider(stub, new StaticProvider(stub)).collect(context);
    expect(await Bun.file(join(repoOut, "graph.json")).exists()).toBe(false);
  });

  test("no usable graph degrades to the static facts and says so", async () => {
    const bare: MapContext = { ...context, outDir: join(context.outDir, "missing") };
    const stub = fakeRunner(new Map([
      ["graphify --version", okResult("0.8.37\n")],
      ["graphify update", { exitCode: 1, stdout: "", stderr: "boom" }],
      ["git log", okResult("")],
    ]));
    const facts = await new GraphifyProvider(stub, new StaticProvider(stub)).collect(bare);
    expect(facts.provider).toContain("graph unavailable");
    expect(facts.docs.commands.length).toBeGreaterThan(0);
  });
});

describe("buildMap and map --check", () => {
  let fixture: Fixture;

  beforeAll(async () => { fixture = await multiRepoFixture(); });
  afterAll(async () => { await fixture.cleanup(); });

  test("writes six documents per repo plus workspace.md, and every citation resolves", async () => {
    const workspace = await detectWorkspace(fixture.root, runner);
    const result = await buildMap({
      workspace, workspaceDir: fixture.root, providers: [new StaticProvider(runner)],
    });

    expect(result.files).toHaveLength(workspace.repos.length * MAP_DOCS.length + 1);
    expect(result.files).toContain(".tldrx/map/workspace.md");
    expect(result.providers).toEqual(["static"]);

    const check = await checkCitations({
      workspaceDir: fixture.root, root: fixture.root,
      repos: workspace.repos.map((repo) => ({ name: repo.name, path: repo.path })),
    });
    expect(check.problems).toEqual([]);
    expect(check.checked).toBeGreaterThan(20);
  });

  test("a deleted file makes its citation fail, naming the document and line", async () => {
    const workspace = await detectWorkspace(fixture.root, runner);
    await buildMap({ workspace, workspaceDir: fixture.root, providers: [new StaticProvider(runner)] });
    await rm(join(fixture.root, "lab", "src", "features", "hunts.ts"));

    const check = await checkCitations({
      workspaceDir: fixture.root, root: fixture.root,
      repos: workspace.repos.map((repo) => ({ name: repo.name, path: repo.path })),
    });
    expect(check.problems.length).toBeGreaterThan(0);
    expect(check.problems.every((problem) => problem.reason === "file does not exist")).toBe(true);
    expect(check.problems[0]?.src).toContain("lab:src/features/hunts.ts");
    expect(check.problems[0]?.file).toStartWith(".tldrx/map/lab/");
  });

  test("a line beyond the end of the file is drift too", async () => {
    await Bun.write(
      join(fixture.root, ".tldrx/map/lab/architecture.md"),
      `# x\n\n- claim ${srcToken(["lab:package.json:9999"])}\n`,
    );
    const check = await checkCitations({
      workspaceDir: fixture.root, root: fixture.root, repos: [{ name: "lab", path: "lab" }],
    });
    expect(check.problems.some((problem) => problem.reason.startsWith("line out of range"))).toBe(true);
  });
});

describe("single-repo mode", () => {
  test("writes map/<repo>/ and no workspace.md", async () => {
    const fixture = await singleRepoFixture();
    try {
      const workspace = await detectWorkspace(fixture.root, runner);
      const result = await buildMap({
        workspace, workspaceDir: fixture.root, providers: [new StaticProvider(runner)],
      });
      expect(workspace.mode).toBe("single-repo");
      expect(workspace.repos[0]?.path).toBe(".");
      expect(result.files).toHaveLength(MAP_DOCS.length);
      expect(result.files.some((file) => file.endsWith("workspace.md"))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
});
