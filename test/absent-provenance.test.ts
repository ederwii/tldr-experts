/**
 * gh #231 (A) — an `absent:…#<needle>` over the workspace's facts.yml must not be
 * contradicted by the framework's own PROVENANCE about a fact.
 *
 * Measured 2026-09-14 on an unattended run (tldrx 0.27.0): the What stage wrote
 * `[src: absent:.tldrx/memory/facts.yml#tenant-credits]`, true when written. In the
 * same instant `run auto` answered the stage's own questions, appending facts whose
 * `source:` map read `run: 260914-tenant-credits` — and `claim-sources` refused with
 * `"tenant-credits" IS at .tldrx/memory/facts.yml:2349 — that is a presence, not an
 * absence`. The needle matched the run id, not anything a fact SAYS.
 *
 * The rule pinned here, and both directions of it:
 *
 *   IGNORED   the `source: {who, when, run, q, decided_by}` flow map `emitFact` writes,
 *             in the workspace's own `.tldrx/memory/facts.yml` — and nothing else.
 *   COUNTED   the needle anywhere a fact carries CONTENT (`fact:`, `area:`,
 *             `alternatives:`, `recommended_why:` …), even on a fact this run wrote.
 *   COUNTED   a `source:` map carrying a key the writer never writes — it is then not
 *             provably provenance, and the dangerous direction is to wave it through.
 *   COUNTED   `source: {… run: …}` in ANY other file: the carve-out is for the one file
 *             whose shape the framework owns.
 *
 * Hermetic: a private temp directory per test, no process spawned.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifySrc, clearSrcCaches, emptySrcContext, resolveSrc, type SrcRef } from "../src/core/text/srcToken.ts";
import { emitFactsYaml } from "../src/core/facts/emitFactsYaml.ts";
import type { Fact } from "../src/core/facts/Fact.ts";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  clearSrcCaches();
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-231-absent-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".tldrx", "memory"), { recursive: true });
  return dir;
}

/** A fact as `run auto`'s own answer writes it — the provenance is the run id. */
function autoAnswered(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "F001",
    fact: "Credits are granted per workspace, never per seat.",
    area: "billing",
    repos: [],
    kind: "answer",
    confidence: "stated",
    source: { who: "alan", when: "2026-09-14T23:44:00Z", run: "260914-tenant-credits", q: "Q1", decided_by: "agent-default" },
    supersedes: null,
    superseded_by: null,
    retired: null,
    ...overrides,
  };
}

function writeFacts(dir: string, facts: readonly Fact[]): void {
  writeFileSync(join(dir, ".tldrx", "memory", "facts.yml"), emitFactsYaml({ version: 1, facts }), "utf8");
}

function resolveIn(dir: string, src: string): unknown {
  return resolveSrc(classifySrc(src) as SrcRef, emptySrcContext(dir), "Unknowns", "none");
}

describe("#231 · a fact's provenance is not a presence", () => {
  test("the field shape: the needle only in `source.run` — the absence holds", () => {
    const dir = root();
    writeFacts(dir, [autoAnswered()]);
    expect(resolveIn(dir, "absent:.tldrx/memory/facts.yml#tenant-credits")).toMatchObject({ ok: true, outcome: "ok" });
  });

  test("the needle in a fact's CONTENT still refuses — even on the fact this run just wrote", () => {
    const dir = root();
    writeFacts(dir, [autoAnswered({ fact: "tenant-credits are granted per workspace." })]);
    expect(resolveIn(dir, "absent:.tldrx/memory/facts.yml#tenant-credits")).toMatchObject({
      ok: false,
      outcome: "refused",
      message: expect.stringContaining(".tldrx/memory/facts.yml:4"),
    });
  });

  test("content AND provenance on different lines: the content line is the one named", () => {
    const dir = root();
    writeFacts(dir, [autoAnswered(), autoAnswered({ id: "F002", area: "tenant-credits" })]);
    expect(resolveIn(dir, "absent:.tldrx/memory/facts.yml#tenant-credits")).toMatchObject({
      ok: false,
      outcome: "refused",
      message: expect.stringContaining(".tldrx/memory/facts.yml:15"),
    });
  });

  test("a `source:` map with a key the writer never writes is not provably provenance — counted", () => {
    const dir = root();
    writeFileSync(
      join(dir, ".tldrx", "memory", "facts.yml"),
      [
        "version: 1",
        "facts:",
        "  - id: F001",
        "    fact: Credits are granted per workspace.",
        "    source: {who: alan, when: 2026-09-14T23:44:00Z, run: init, q: null, note: tenant-credits live here}",
        "",
      ].join("\n"),
      "utf8",
    );
    expect(resolveIn(dir, "absent:.tldrx/memory/facts.yml#tenant-credits")).toMatchObject({ ok: false, outcome: "refused" });
  });

  test("the same `source:` line in any OTHER file is content — counted", () => {
    const dir = root();
    writeFileSync(
      join(dir, "notes.yml"),
      "    source: {who: alan, when: 2026-09-14T23:44:00Z, run: 260914-tenant-credits, q: Q1}\n",
      "utf8",
    );
    expect(resolveIn(dir, "absent:notes.yml#tenant-credits")).toMatchObject({ ok: false, outcome: "refused" });
  });
});
