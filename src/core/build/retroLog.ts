/**
 * `tldrx-work/<run>/retro.md` — the half Build writes, deterministically.
 *
 * The loop this closes was measured 2026-08-29 and it was open at both ends. The
 * five ROLE experts (`developer`, `quality`, `delivery`, …) mine past runs for
 * what the team keeps deciding — `mineRuns.ts` reads `handoff.md` and `retro.md`
 * and nothing else — and every one of them sat at `level: 0`, because `retro.md`
 * only existed when a human happened to type `tldrx retro`. Meanwhile the richest
 * feedback the framework produces never reached any file a role expert reads:
 * a reviewer's `changes` verdict, a DoD command that failed on the first attempt,
 * a gate a person rejected with a note, an approval taken back. Those are the
 * moments this team learned something, and they were written to `events.jsonl`,
 * to a per-story review log, and to nothing an expert mines.
 *
 * So the Build executor appends them as it goes, in `## Build feedback`, one
 * bullet per event, no model involved. Three properties make that safe to do on
 * every invocation:
 *
 *   - **Append, deduped verbatim.** Build runs again after a rejection; the same
 *     bullet is not written twice, so `--prepare`/`--commit` and a second `next`
 *     over the same stories converge rather than accumulate.
 *   - **The section is always last.** `tldrx retro` rewrites the file whole, and
 *     it now carries this section forward (`retro/renderRetro.ts`) rather than
 *     overwriting the one part of it nothing else can reconstruct.
 *   - **Every bullet cites something re-resolvable** — the story's own review log
 *     or the `events.jsonl` line — so a knowledge file mined from it inherits a
 *     `[src: …]` that still means something.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dodGreen, type StoryOutcome } from "./outcome.ts";

/**
 * `tldrx-work/<run>/retro.md`. The name lives HERE rather than in `retro/`
 * because two writers share it — `tldrx retro` renders the whole document and
 * the Build executor appends one section to it — and the renderer imports this
 * module to carry that section forward. One direction, one constant.
 */
export const RETRO_FILE = "retro.md";

/** The H2 Build owns. Everything under it to the end of the file is its section. */
export const BUILD_RETRO_SECTION = "Build feedback";

const HEADING = `## ${BUILD_RETRO_SECTION}`;
const PREAMBLE =
  "Appended by the Build executor as each story settled, and by nothing else. Deterministic: "
  + "no model ran. Every bullet is a moment the loop pushed back — a reviewer asking for "
  + "changes, a definition-of-done command failing, a gate refused or an approval taken back.";

export function buildRetroPath(runDir: string): string {
  return join(runDir, RETRO_FILE);
}

/**
 * One story's bullets: a developer that FAILED, the reviewer's `changes` verdict
 * (or its FAILURE to return one), and every DoD command that failed on the FIRST
 * attempt.
 *
 * "On the first attempt" is the interesting one and it is why `attempts` is read
 * rather than the final status. A command that failed, was fixed and then passed
 * is the team learning something; a command that failed on the retry as well is
 * already in the blocked story's own reason.
 */
export function storyRetroLines(outcome: StoryOutcome, runId: string): readonly string[] {
  const lines: string[] = [];
  const src = `[src: tldrx-work/${runId}/${outcome.reviewRel}:1]`;

  if (outcome.verdict === "changes") {
    lines.push(
      `- \`${outcome.id}\` — the reviewer asked for CHANGES on attempt ${String(outcome.attempts)}: `
      + `${oneLine(outcome.reviewSummary)} ${src}`,
    );
    for (const finding of outcome.reviewFindings) {
      lines.push(`- \`${outcome.id}\` — reviewer finding: ${oneLine(finding)} ${src}`);
    }
  }

  // A developer that FAILED is the loudest push-back of all: the story bought a
  // turn and got nothing, and the number the team has to change is a budget, not
  // a line of code. It is deliberately NOT filed as a reviewer verdict — nobody
  // judged anything here.
  if (outcome.developerError !== null) {
    lines.push(
      `- \`${outcome.id}\` — the developer FAILED and produced no work on attempt `
      + `${String(outcome.attempts)}: ${oneLine(outcome.developerError)} ${src}`,
    );
  }

  // A reviewer that FAILED is push-back too, and of the most expensive kind: the
  // developer's turn is already paid for and nothing has judged it.
  if (outcome.verdict === "error") {
    lines.push(
      `- \`${outcome.id}\` — the reviewer FAILED and returned no verdict on attempt `
      + `${String(outcome.attempts)}: ${oneLine(outcome.reviewSummary)} ${src}`,
    );
  }

  if (outcome.attempts === 1 && !dodGreen(outcome)) {
    for (const result of outcome.dod) {
      if (result.exitCode === 0 && !result.timedOut) continue;
      lines.push(
        `- \`${outcome.id}\` — dod \`${result.command}\` exited ${String(result.exitCode)} on the first `
        + `attempt${result.timedOut ? " (timed out)" : ""} ${src}`,
      );
    }
  }

  if (outcome.conflicts.length > 0) {
    lines.push(
      `- \`${outcome.id}\` — \`${outcome.branch}\` would not merge into \`${outcome.epicBranch}\`; `
      + `conflicts in ${outcome.conflicts.map((path) => `\`${path}\``).join(", ")} ${src}`,
    );
  }
  return lines;
}

/**
 * Every gate a person refused and every approval taken back, read off the log.
 *
 * These happen OUTSIDE the executor — `tldrx reject` and `tldrx reject --stage`
 * run between invocations — so they are recovered from `events.jsonl` at the top
 * of the next Build run rather than emitted at the moment they occur. The line
 * number of the event is the citation, exactly as `tldrx retro` cites one.
 */
export function gateRetroLines(runDir: string, runId: string): readonly string[] {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const lines: string[] = [];
  const rows = text.split("\n");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? "";
    if (row.trim() === "") continue;
    let event: { type?: string; stage?: string | null; actor?: string; payload?: Record<string, unknown> };
    try {
      event = JSON.parse(row) as typeof event;
    } catch {
      // A torn last line is not a reason to lose the ones before it.
      continue;
    }
    if (event.type !== "gate.rejected" && event.type !== "gate.revoked") continue;
    const src = `[src: tldrx-work/${runId}/events.jsonl:${String(i + 1)}]`;
    const where = `${str(event.payload?.phase)}/${str(event.stage)}`;
    const note = oneLine(str(event.payload?.note));
    if (event.type === "gate.rejected") {
      lines.push(`- \`${where}\` — gate REJECTED by ${str(event.actor)}: ${note} ${src}`);
      continue;
    }
    const staled = Array.isArray(event.payload?.staled)
      ? (event.payload.staled as unknown[]).filter((item): item is string => typeof item === "string")
      : [];
    lines.push(
      `- \`${where}\` — approval REVOKED by ${str(event.actor)} (signed by `
      + `${str(event.payload?.signed_by) || "unknown"}): ${note}`
      + `${staled.length === 0 ? "" : `; stale: ${staled.map((s) => `\`${s}\``).join(", ")}`} ${src}`,
    );
  }
  return lines;
}

/**
 * Append bullets to the run's `retro.md`, skipping any already there verbatim.
 *
 * Returns the lines actually written, so a caller can report a number it measured
 * rather than the number it asked for.
 */
export function appendBuildRetro(runDir: string, incoming: readonly string[]): readonly string[] {
  if (incoming.length === 0) return [];
  const path = buildRetroPath(runDir);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const { before, section } = splitBuildSection(existing);

  const already = new Set(section.split("\n").map((line) => line.trim()));
  const added = incoming.filter((line) => !already.has(line.trim()));
  if (added.length === 0) return [];

  const body = [...section.split("\n").filter((line) => line.trim() !== ""), ...added];
  const head = before.trimEnd();
  const out = [
    head === "" ? `# Retro — build feedback` : head,
    "",
    HEADING,
    "",
    PREAMBLE,
    "",
    ...body,
    "",
  ].join("\n");

  mkdirSync(runDir, { recursive: true });
  writeFileSync(path, out, "utf8");
  return added;
}

/** The bullets currently under `## Build feedback`, or `""`. */
export function extractBuildSection(text: string): string {
  return splitBuildSection(text).section;
}

interface SplitRetro {
  /** Everything before `## Build feedback`. */
  readonly before: string;
  /** The section's BULLETS — its heading and preamble are re-rendered, never kept. */
  readonly section: string;
}

function splitBuildSection(text: string): SplitRetro {
  if (text === "") return { before: "", section: "" };
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trimEnd() === HEADING);
  if (at === -1) return { before: text, section: "" };
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  const body = (end === -1 ? rest : rest.slice(0, end))
    .filter((line) => line.trimStart().startsWith("- "));
  const tail = end === -1 ? [] : rest.slice(end);
  return {
    before: [...lines.slice(0, at), ...tail].join("\n").replace(/\n{3,}/g, "\n\n"),
    section: body.join("\n"),
  };
}

function oneLine(text: string): string {
  const first = text.split("\n").find((line) => line.trim() !== "") ?? "";
  return first.trim() === "" ? "(no comment)" : first.trim();
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
