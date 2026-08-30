/**
 * Wave Q — what survives a kill, and what a stuck run looks like from outside.
 *
 * The 2026-08-29 audit (`docs/audits/2026-08-29/state-resumability.md`) scored the
 * framework 6/10 on this: the FILES resume fine, but the process and the money did
 * not, and nothing guarded the two files several runs share. Every test here pins
 * one of those holes shut. Nothing spawns a real `claude`: the only sub-agent is
 * the fake fixture, and the signal tests send a real signal to a real `tldrx`
 * child process.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpSync, mkdtempSync } from "node:fs";
import { loadRun, renderReplay } from "../src/core/replay/index.ts";
import { VIEWS_FIXTURE, VIEWS_RUN } from "./fixtures/views/tempViews.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, skippedNote } from "../src/core/events/EventLog.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";

let temps: string[] = [];

afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-resume-"));
  temps.push(dir);
  return dir;
}

function anEvent(type: TldrxEvent["type"], stage: string | null = null): TldrxEvent {
  return { ts: "2026-08-29T09:00:00Z", run: "260829-demo", stage, type, actor: "alan", cost_usd: 0, payload: {} };
}

// --- Q6: a torn line must not take the history with it ----------------------

describe("EventLog.read tolerates a torn line", () => {
  test("a half-written last line is skipped, not thrown, and the rest survives", () => {
    const dir = tempDir();
    const log = new EventLog(join(dir, "events.jsonl"));
    log.append(anEvent("run.created"));
    log.append(anEvent("stage.started", "alpha"));
    // The kill lands between the `{` and the `\n`.
    appendFileSync(log.path, '{"ts":"2026-08-29T09:00:01Z","run":"260829-demo","sta', "utf8");

    const result = log.readAll();
    expect(result.events.map((e) => e.type)).toEqual(["run.created", "stage.started"]);
    expect(result.skipped).toBe(1);
    // Line numbers still point at the real lines, so replay's `L<n>` is honest.
    expect(result.lines).toEqual([1, 2]);
  });

  test("read() never throws on a partial line and warns once per path", () => {
    const dir = tempDir();
    const log = new EventLog(join(dir, "events.jsonl"));
    log.append(anEvent("run.created"));
    appendFileSync(log.path, "{not json at all", "utf8");

    const said: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      said.push(s);
      return true;
    };
    try {
      expect(log.read().map((e) => e.type)).toEqual(["run.created"]);
      // Second and third reads say nothing: the warning is once per path.
      log.read();
      new EventLog(log.path).read();
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
    expect(said.length).toBe(1);
    expect(said[0]).toContain("1 line skipped");
  });

  test("a torn line in the MIDDLE is skipped too — the reader never gives up early", () => {
    const dir = tempDir();
    const path = join(dir, "events.jsonl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(anEvent("run.created"))}\n` +
        "{ torn\n" +
        `${JSON.stringify(anEvent("stage.done", "alpha"))}\n`,
      "utf8",
    );
    const result = new EventLog(path).readAll();
    expect(result.events.map((e) => e.type)).toEqual(["run.created", "stage.done"]);
    expect(result.skipped).toBe(1);
    expect(result.lines).toEqual([1, 3]);
  });

  test("skippedNote is the one phrasing both the warning and replay use", () => {
    expect(skippedNote(1)).toBe("1 line skipped");
    expect(skippedNote(3)).toBe("3 lines skipped");
  });

  test("replay renders the note instead of losing the whole history", () => {
    const dir = tempDir();
    cpSync(VIEWS_FIXTURE, dir, { recursive: true });
    appendFileSync(join(dir, "tldrx-work", VIEWS_RUN, "events.jsonl"), '{"ts":"2026-09-01T12:00:00Z","run":"', "utf8");

    const loaded = loadRun(dir, VIEWS_RUN);
    expect(loaded).not.toBeNull();
    expect(loaded!.eventsError).toBeNull();
    expect(loaded!.eventsSkipped).toBe(1);
    expect(loaded!.events.length).toBeGreaterThan(0);
    const narrative = renderReplay(loaded!);
    expect(narrative).toContain("1 line skipped");
    expect(narrative).toContain("### what");
  });

  test("a missing file is still no events and no skips", () => {
    expect(new EventLog(join(tempDir(), "nope.jsonl")).readAll()).toEqual({ events: [], lines: [], skipped: 0 });
  });
});
