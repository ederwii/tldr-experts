/**
 * The two things a prompt needs out of `expert.md`: the YAML front matter and
 * the body of a named H2 section.
 *
 * Not a Markdown parser — `src/core/markdown/` is for rendering, and
 * `src/core/text/handoff.ts` parses the *handoff* contract, which expert.md is
 * not. This is a section slicer, and it stays that small on purpose.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPERT_FILE, expertDir } from "./loadExperts.ts";

export interface ExpertDocument {
  readonly path: string;
  readonly exists: boolean;
  readonly frontMatter: ReadonlyMap<string, string>;
  readonly body: string;
}

const H2_RE = /^##\s+(.+?)\s*$/;

export function readExpertDocument(root: string, name: string): ExpertDocument {
  const path = join(expertDir(root, name), EXPERT_FILE);
  if (!existsSync(path)) {
    return { path, exists: false, frontMatter: new Map(), body: "" };
  }
  const text = readFileSync(path, "utf8");
  const { frontMatter, body } = splitFrontMatter(text);
  return { path, exists: true, frontMatter, body };
}

export function splitFrontMatter(text: string): { frontMatter: Map<string, string>; body: string } {
  const frontMatter = new Map<string, string>();
  if (!text.startsWith("---\n")) return { frontMatter, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { frontMatter, body: text };

  for (const line of text.slice(4, end).split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0 || line.trimStart().startsWith("#")) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).replace(/#.*$/, "").trim().replace(/^"(.*)"$/, "$1");
    if (key !== "") frontMatter.set(key, value);
  }
  const newline = text.indexOf("\n", end + 1);
  return { frontMatter, body: newline === -1 ? "" : text.slice(newline + 1) };
}

/** The lines under `## <heading>`, trimmed. Empty string when absent. */
export function section(body: string, heading: string): string {
  const lines = body.split("\n");
  const collected: string[] = [];
  let inside = false;
  for (const line of lines) {
    const match = H2_RE.exec(line);
    if (match !== null) {
      if (inside) break;
      inside = match[1] === heading;
      continue;
    }
    if (inside) collected.push(line);
  }
  return collected.join("\n").trim();
}
