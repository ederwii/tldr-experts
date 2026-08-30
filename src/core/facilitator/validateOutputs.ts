/**
 * Spec §5: `for out in sy.outputs: if !exists(out.path) or !has_sections(out): goto FAIL`
 * with the note that matters most — **re-read from disk**.
 *
 * The sub-agent's envelope lists what it believes it wrote. This module never
 * looks at that list. A file exists or it does not; a section has content or it
 * does not; both questions are answered by reading bytes back off the filesystem.
 *
 * A declared output can be a PATTERN — `03-plan/stories/<id>.md` — because the
 * Plan stage does not know how many stories it will write until it has written
 * them. A pattern is satisfied by one or more matching files, and every one of
 * them is held to the same `sections:` contract. Until 2026-08-30 the pattern
 * string went to `existsSync` verbatim, so a Plan that had written seven stories
 * failed with "does not exist on disk" while the seven files sat next to the
 * error message.
 */
import { existsSync, readFileSync } from "node:fs";
import { isPattern, matchPattern, resolveDeclared, type PathContext } from "./paths.ts";

export interface OutputProblem {
  readonly path: string;
  readonly message: string;
}

export function validateOutputs(
  outputs: readonly string[],
  sections: ReadonlyMap<string, readonly string[]>,
  ctx: PathContext,
): readonly OutputProblem[] {
  const problems: OutputProblem[] = [];
  for (const declared of outputs) {
    const required = sections.get(declared) ?? [];
    if (isPattern(declared)) {
      const matched = matchPattern(declared, ctx);
      if (matched.length === 0) {
        // Not "does not exist": nobody declared that path. What was declared is a
        // shape, and the honest failure is that the directory holds nothing of it.
        problems.push({ path: declared, message: "was declared as an output but no file matches it on disk" });
        continue;
      }
      // Every match, not the first: `sections:` is the contract for the SHAPE, so
      // a story that skipped a required heading is a failure even if six siblings
      // carry it.
      for (const hit of matched) problems.push(...sectionProblems(hit.path, hit.absolute, required));
      continue;
    }
    const absolute = resolveDeclared(declared, ctx);
    if (!existsSync(absolute)) {
      problems.push({ path: declared, message: "was declared as an output but does not exist on disk" });
      continue;
    }
    problems.push(...sectionProblems(declared, absolute, required));
  }
  return problems;
}

/** §2.3 `sections:` for ONE file on disk: present, and not empty. */
function sectionProblems(
  path: string,
  absolute: string,
  required: readonly string[],
): readonly OutputProblem[] {
  if (required.length === 0) return [];
  const problems: OutputProblem[] = [];
  const found = sectionBodies(readFileSync(absolute, "utf8"));
  for (const heading of required) {
    const body = found.get(heading);
    if (body === undefined) {
      problems.push({ path, message: `is missing the required section \`## ${heading}\`` });
      continue;
    }
    if (body.trim() === "") {
      problems.push({ path, message: `has an empty \`## ${heading}\` section` });
    }
  }
  return problems;
}

/** H2 heading -> everything under it up to the next H2. */
export function sectionBodies(markdown: string): ReadonlyMap<string, string> {
  const bodies = new Map<string, string>();
  const lines = markdown.split("\n");
  let heading: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (heading !== null) bodies.set(heading, buffer.join("\n"));
    buffer = [];
  };
  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      heading = line.slice(3).trim();
      continue;
    }
    if (heading !== null) buffer.push(line);
  }
  flush();
  return bodies;
}

export function describeProblems(problems: readonly OutputProblem[]): string {
  return problems.map((p) => `${p.path} ${p.message}`).join("; ");
}
