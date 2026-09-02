/**
 * Issue #126 — `docs/spec.md` §2.10 designed four `env.yml` validation rules and
 * `validateEnv` enforced none of them.
 *
 * #125 fixed the EXAMPLE above that paragraph and reworded the paragraph itself
 * from a statement of fact into "designed and not yet enforced". Honest, and it
 * settled nothing: three rules were still prose, and one of them contradicted the
 * runtime.
 *
 * The owner's decision, #126: **enforce two, delete one.**
 *
 *   - **ids unique** and **≤64 tools** are enforced here. A duplicate id is a real
 *     defect today — `runDoctor` probes the tool twice and prints two rows for one
 *     entry — and nothing bounded the file at all.
 *   - **`check` free of `; && | > \``** is DELETED from the spec, not implemented.
 *     `ToolChecker.check` runs `runtime.spawn("sh", ["-c", tool.check])`
 *     (`src/core/doctor/ToolChecker.ts`) — a `check` IS a shell command line, and
 *     has been on every version that ever shipped. The spec's own `[assumption]`
 *     two sentences later needs it: `check: "test -n \"$VAR\""` is nothing without
 *     a shell to expand `$VAR`. `env.yml` is a committed file its owner writes and
 *     reviews like code, and `doctor` runs it as that owner, on that owner's
 *     machine. Refusing metacharacters would not have been a check to add; it
 *     would have been a behaviour change that broke the manifest's own idiom to
 *     defend against the file's own author.
 *
 * The `result:` / `checked_at` prose is untouched — it stays as #125 left it,
 * designed-and-not-built, and says so.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_ENV_TOOLS, validateEnv } from "../src/core/schemas/env.ts";
import { ToolChecker } from "../src/core/doctor/ToolChecker.ts";
import { loadEnvManifest } from "../src/core/doctor/loadEnvManifest.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";

/** One well-formed tool entry; callers override the fields the test is about. */
function tool(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, required: false, check: `${id} --version`, install: { all: `install ${id}` }, ...extra };
}

function doc(tools: readonly unknown[]): Record<string, unknown> {
  return { version: 1, tools };
}

function messages(input: unknown): string {
  return validateEnv(input).issues.map((i) => `${i.path}: ${i.message}`).join("; ");
}

// ---------------------------------------------------------------------------
// A. Ids unique across tools
// ---------------------------------------------------------------------------

describe("a tool id is a key, so it may appear once", () => {
  test("two tools sharing an id are refused, naming the id and where it was first declared", () => {
    const check = validateEnv(doc([tool("git"), tool("node"), tool("git")]));
    expect(check.ok).toBe(false);
    expect(messages(doc([tool("git"), tool("node"), tool("git")])))
      .toContain("tools[2].id: `git` is already declared by tools[0]");
  });

  test("the message says what a duplicate actually costs — it is not a style rule", () => {
    expect(messages(doc([tool("gh"), tool("gh")])))
      .toContain("probed twice and reported twice");
  });

  test("three of the same id is two issues, not one and not three", () => {
    const issues = validateEnv(doc([tool("bun"), tool("bun"), tool("bun")])).issues;
    expect(issues.filter((i) => i.message.includes("already declared"))).toHaveLength(2);
  });

  test("distinct ids are accepted, and so is the framework's own manifest", async () => {
    expect(validateEnv(doc([tool("git"), tool("node"), tool("claude")])).ok).toBe(true);
    const manifest = await loadEnvManifest();
    const ids = manifest.tools.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a non-string id is reported as a type error and never as a duplicate", () => {
    const said = messages(doc([tool("git"), { ...tool("git"), id: 7 }]));
    expect(said).toContain("tools[1].id: expected a string, got number");
    expect(said).not.toContain("already declared");
  });
});

// ---------------------------------------------------------------------------
// B. At most 64 tools
// ---------------------------------------------------------------------------

describe("the manifest is bounded", () => {
  test(`${String(MAX_ENV_TOOLS)} tools are accepted`, () => {
    const many = Array.from({ length: MAX_ENV_TOOLS }, (_, i) => tool(`t${String(i)}`));
    expect(validateEnv(doc(many)).issues).toEqual([]);
  });

  test(`${String(MAX_ENV_TOOLS + 1)} are refused, and the message interpolates the cap`, () => {
    const many = Array.from({ length: MAX_ENV_TOOLS + 1 }, (_, i) => tool(`t${String(i)}`));
    const check = validateEnv(doc(many));
    expect(check.ok).toBe(false);
    expect(check.issues.map((i) => `${i.path}: ${i.message}`))
      .toContain(`tools: ${String(MAX_ENV_TOOLS + 1)} tools exceeds the ${String(MAX_ENV_TOOLS)} cap`);
  });
});

// ---------------------------------------------------------------------------
// C. `check` is a shell command line — the rule that was deleted
// ---------------------------------------------------------------------------

describe("`check` is a shell command line, and the schema says so by accepting one", () => {
  test("metacharacters are accepted — every one the deleted rule named", () => {
    const shellish = ["a; b", "a && b", "a | b", "a > b", "`a`", 'test -n "$CONTEXT7_API_KEY"'];
    for (const check of shellish) {
      expect(validateEnv(doc([tool("x", { check })])).ok, `\`${check}\` must validate`).toBe(true);
    }
  });

  test("the runtime really does run it through a shell — measured, not asserted from the source", async () => {
    // `&&` and `$VAR` are the shell's, not argv's. If `check` were spawned as a
    // single argv this exits 127 and reports `missing`.
    const result = await new ToolChecker().check({
      id: "shell-probe", required: false,
      check: 'V=9.9.9 && echo "shell-probe $V"',
      install: { all: "n/a" },
    });
    expect(result.status).toBe("ok");
    expect(result.found).toBe("9.9.9");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// D. The spec no longer designs a property the code does not have
// ---------------------------------------------------------------------------

describe("docs/spec.md §2.10", () => {
  /** The `**Validation.**` paragraph under the `### 2.10 … env.yml` heading. */
  function validationParagraph(): string {
    const spec = readFileSync(join(FRAMEWORK_ROOT, "docs", "spec.md"), "utf8");
    const start = spec.indexOf("### 2.10 ");
    expect(start, "docs/spec.md no longer has a `### 2.10 …` heading").toBeGreaterThan(-1);
    const section = spec.slice(start, spec.indexOf("### 2.11 ", start));
    const at = section.indexOf("**Validation.**");
    expect(at, "§2.10 no longer has a **Validation.** paragraph").toBeGreaterThan(-1);
    return section.slice(at).split("\n\n")[0] ?? "";
  }

  test("states the two rules that ARE enforced", () => {
    const said = validationParagraph();
    expect(said).toContain("unique");
    expect(said).toContain(String(MAX_ENV_TOOLS));
  });

  test("does not design a metacharacter rule, and says what `check` is instead", () => {
    const said = validationParagraph();
    expect(said).not.toContain("free of");
    expect(said, "§2.10 must name the shell it actually runs the check under").toContain("sh -c");
  });
});
