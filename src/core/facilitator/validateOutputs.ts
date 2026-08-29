/**
 * Spec §5: `for out in sy.outputs: if !exists(out.path) or !has_sections(out): goto FAIL`
 * with the note that matters most — **re-read from disk**.
 *
 * The sub-agent's envelope lists what it believes it wrote. This module never
 * looks at that list. A file exists or it does not; a section has content or it
 * does not; both questions are answered by reading bytes back off the filesystem.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolveDeclared, type PathContext } from "./paths.ts";

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
    const absolute = resolveDeclared(declared, ctx);
    if (!existsSync(absolute)) {
      problems.push({ path: declared, message: "was declared as an output but does not exist on disk" });
      continue;
    }
    const required = sections.get(declared) ?? [];
    if (required.length === 0) continue;
    const found = sectionBodies(readFileSync(absolute, "utf8"));
    for (const heading of required) {
      const body = found.get(heading);
      if (body === undefined) {
        problems.push({ path: declared, message: `is missing the required section \`## ${heading}\`` });
        continue;
      }
      if (body.trim() === "") {
        problems.push({ path: declared, message: `has an empty \`## ${heading}\` section` });
      }
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
