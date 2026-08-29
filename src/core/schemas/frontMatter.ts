/**
 * The YAML front-matter block a Plan artefact opens with (spec §2.13, §2.14).
 *
 * `03-plan/stories/<id>.md` and `03-plan/epics/<id>.md` are Markdown a human reads
 * and a machine gates on. The machine-read half is a fenced YAML block at the very
 * top; everything after it is prose plus, for a story, the fenced ```dod block.
 *
 * Deliberately not a Markdown parser: first line must be `---`, the block ends at
 * the next line that is exactly `---`, and the split is byte slicing. That keeps a
 * hook's read+parse+validate inside the 50 ms budget of spec §0.
 */
import { parseYaml } from "../yaml.ts";
import type { ValidationIssue } from "./validation.ts";

export const FENCE = "---";

export interface FrontMatter {
  /** True when the file opens with a closed `---` block. */
  readonly present: boolean;
  /** The YAML text between the fences (no fences), or `""`. */
  readonly raw: string;
  /** Everything after the closing fence. */
  readonly body: string;
  /** 1-based line the body starts on — used to report a dod issue at a real line. */
  readonly bodyLine: number;
}

/** Split `text` into its front matter and its body. Never throws. */
export function splitFrontMatter(text: string): FrontMatter {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trimEnd() !== FENCE) {
    return { present: false, raw: "", body: text, bodyLine: 1 };
  }
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trimEnd() !== FENCE) continue;
    return {
      present: true,
      raw: lines.slice(1, i).join("\n"),
      body: lines.slice(i + 1).join("\n"),
      bodyLine: i + 2,
    };
  }
  return { present: false, raw: "", body: text, bodyLine: 1 };
}

export interface FrontMatterDoc {
  readonly frontMatter: FrontMatter;
  /** The parsed YAML mapping, or `null` when there is none or it did not parse. */
  readonly doc: unknown;
  /** Why `doc` is null, as a validation issue ready to report. */
  readonly issue: ValidationIssue | null;
}

/** Split and parse. A missing or unparseable block is an issue, never an exception. */
export function parseFrontMatter(text: string): FrontMatterDoc {
  const frontMatter = splitFrontMatter(text);
  if (!frontMatter.present) {
    return {
      frontMatter,
      doc: null,
      issue: {
        path: "",
        message: "no YAML front matter — the file must open with `---` and close the block with `---`",
      },
    };
  }
  try {
    return { frontMatter, doc: parseYaml(frontMatter.raw), issue: null };
  } catch (error) {
    return {
      frontMatter,
      doc: null,
      issue: { path: "", message: `front matter is not valid YAML: ${message(error)}` },
    };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? "parse error" : String(error);
}
