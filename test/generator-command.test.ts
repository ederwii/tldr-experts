/**
 * A mutating generator command (a migration-add, a scaffold, an un-verified
 * format) may not appear in a story's ```dod block (gh #362).
 *
 * Measured live, tldrx 0.31.1: a `.NET` story's dod block declared, among
 * ordinary `dotnet build`/`dotnet test` lines, `dotnet ef migrations add …`.
 * The base-tree pre-flight ran it against the UNTOUCHED base tree as a routine
 * MEASUREMENT and would have written a migration triple into pristine `main`
 * as a side effect of asking a question — it only failed to reach `main`
 * because `dotnet-ef` was not yet restored in that environment. This file pins
 * the ONE derivation both refusal doors read (`isGeneratorCommand`,
 * `schemas/commandAllowlist.ts`) and the Plan-time door itself
 * (`validateStoryDod`); the base-tree probe's own defense-in-depth door is
 * pinned in `test/dod-preflight.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  generatorDodMessage, isGeneratorCommand,
} from "../src/core/schemas/commandAllowlist.ts";
import { parseDodBlock, validateStoryDod } from "../src/core/schemas/story.ts";

describe("isGeneratorCommand (gh #362)", () => {
  const generators: readonly string[] = [
    "dotnet ef migrations add Tenancy",
    "dotnet ef migrations add Tenancy --project src/Data --startup-project src/Api",
    "prisma migrate dev --name init",
    "npx prisma migrate new",
    "rails generate scaffold Post",
    "dotnet scaffold",
    "dotnet format",
    "npm run format",
  ];
  for (const command of generators) {
    test(`\`${command}\` is a generator`, () => {
      expect(isGeneratorCommand(command)).toBe(true);
    });
  }

  const ordinary: readonly string[] = [
    "dotnet build -c Release",
    "dotnet test",
    "dotnet format --verify-no-changes",
    "dotnet format --verify",
    "dotnet ef migrations remove",
    "dotnet ef database update",
    "prisma migrate deploy",
    "prisma migrate status",
    "npm run test",
    // A compound npm-script name carrying the word as a SUBSTRING, not a whole
    // ARGV token — the false-positive shape the classifier must not catch.
    "npm run format:check",
    "sha256sum s1.txt",
    "pytest -q",
    // gh #362 review: `--check` is the standard idempotent verify flag for
    // prettier/black/rustfmt/gofmt — not accepting it flagged a COMMON dod
    // line, a new stall class, not the rare `.NET`-shaped one the issue
    // measured. `--dry-run`/`--diff` are the same shape from other formatters.
    "npm run format -- --check",
    "prettier --check .",
    "black --check .",
    "cargo fmt --check",
    "gofmt --dry-run .",
    "terraform fmt --diff",
  ];
  for (const command of ordinary) {
    test(`\`${command}\` is NOT a generator`, () => {
      expect(isGeneratorCommand(command)).toBe(false);
    });
  }
});

describe("generatorDodMessage (gh #362)", () => {
  test("names the command and says why a dod block may not name it", () => {
    const message = generatorDodMessage("dotnet ef migrations add Tenancy");
    expect(message).toContain("dotnet ef migrations add Tenancy");
    expect(message).toContain("GENERATOR");
  });
});

describe("validateStoryDod refuses a generator line (gh #362)", () => {
  const ALLOWED = new Set(["dotnet build", "dotnet test", "dotnet ef migrations add Tenancy"]);

  test("a dod line that is BOTH declared and a generator is refused as a generator, not allowed", () => {
    const dod = parseDodBlock(
      "```dod\ndotnet build\ndotnet ef migrations add Tenancy\n```\n",
    );
    const issues = validateStoryDod(dod, ALLOWED);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("GENERATOR");
    expect(issues[0]?.message).toContain("dotnet ef migrations add Tenancy");
  });

  test("an ordinary declared dod block is unaffected", () => {
    const dod = parseDodBlock("```dod\ndotnet build\ndotnet test\n```\n");
    const issues = validateStoryDod(dod, ALLOWED);
    expect(issues).toEqual([]);
  });
});
