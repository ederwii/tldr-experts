/**
 * YAML access, in one place.
 *
 * Parsing and serialisation go through the runtime seam (`src/core/runtime/`):
 * on Bun that is the native YAML implementation, on Node it is the `yaml` npm
 * package inlined by the build. Nothing else in the framework touches YAML
 * directly, so the host runtime is a detail of one folder.
 */
import { readFileSync } from "node:fs";
import { runtime } from "./runtime/index.ts";

export function parseYaml(text: string): unknown {
  return runtime.parseYaml(text);
}

/**
 * Block style by default (indent 2): every YAML file this framework writes is
 * meant to be read and diffed by a human. Pass `indent: 0` for the compact form.
 */
export function stringifyYaml(value: unknown, indent = 2): string {
  return runtime.stringifyYaml(value, indent);
}

export async function readYamlFile(path: string): Promise<unknown> {
  return parseYaml(await runtime.readText(path));
}

/** Sync twin, for the hooks — they have a 50 ms budget and no room to await. */
export function readYamlFileSync(path: string): unknown {
  return parseYaml(readFileSync(path, "utf8"));
}

/** What `parseYamlRepairing` did to get a document out of the text it was given. */
export interface RepairedYaml {
  readonly doc: unknown;
  /**
   * True when the raw text did NOT parse and the newline repair below is what
   * made it parse. A caller that can write should re-emit the file; a caller
   * that only reads should say so rather than pretend the file was fine.
   */
  readonly repaired: boolean;
}

/**
 * Parse, and if that fails, try the ONE repair we know how to make: rejoining a
 * double-quoted scalar that a literal newline broke in half.
 *
 * This is the inverse of the bug in `yamlScalar`, which until 2026-08-31 wrote
 * operator text into a double-quoted flow scalar without escaping newlines. The
 * emitter is fixed, but fixing an emitter does nothing for the files it already
 * wrote — and those files are the resume point of runs in flight. Worse, the
 * corruption was self-renewing: a hand-repaired file loaded fine, and the very
 * next save re-emitted the same in-memory string as literal newlines again
 * (measured on the live `260829-scoring-leaderboard` run, where both `run.yml`
 * and its backup ended up broken at the same line). Repairing on LOAD closes
 * that loop from the other side: the string comes back whole, and the fixed
 * emitter writes it back escaped.
 *
 * The repair is mechanical and refuses to guess: it rejoins and re-escapes, then
 * hands the result to the same parser. If that still does not parse, the
 * ORIGINAL error is thrown — a repair that cannot be verified is not offered.
 */
export function parseYamlRepairing(text: string): RepairedYaml {
  try {
    return { doc: parseYaml(text), repaired: false };
  } catch (original) {
    const mended = rejoinBrokenQuotedScalars(text);
    if (mended === null) throw original;
    try {
      return { doc: parseYaml(mended), repaired: true };
    } catch {
      throw original;
    }
  }
}

/**
 * Re-escape every raw control character sitting inside a double-quoted scalar —
 * the line breaks that split it in half among them.
 *
 * Returns `null` when there was nothing of that shape to fix, so the caller can
 * tell "no repair applies" from "repaired to the same text".
 *
 * The old emitter escaped `\\` and `"` and nothing else, so a note carried its
 * newlines, carriage returns and NULs into the file as raw bytes. A newline is
 * the one that stops the file parsing outright; the others are just as illegal
 * inside a double-quoted scalar and would fail the moment the newline was fixed,
 * so all of them are escaped in the same pass. A TAB is left alone: YAML counts
 * it printable, and it round-trips as itself.
 *
 * Quote tracking walks character by character rather than counting quotes: a
 * `\"` inside a scalar must not close it, a `\\` before a `"` must not protect
 * it, a `#` comment outside a scalar must not have its apostrophes read as YAML,
 * and a single-quoted scalar — which this framework never emits but a hand-edit
 * may leave — must not have a `"` inside it toggle anything.
 *
 * A scalar still open at the end of the text is NOT this corruption; it is a
 * truncated file, and escaping our way to the end of it would not make it parse.
 */
export function rejoinBrokenQuotedScalars(text: string): string | null {
  const out: string[] = [];
  let changed = false;
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inDouble) {
      if (ch === "\\") {
        out.push(ch, text[i + 1] ?? "");
        i++;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
        out.push(ch);
        continue;
      }
      const escaped = CONTROL_ESCAPES[ch];
      if (escaped !== undefined) {
        out.push(escaped);
        changed = true;
        continue;
      }
      out.push(ch);
      continue;
    }
    if (inSingle) {
      // YAML escapes a quote inside a single-quoted scalar by doubling it.
      if (ch === "'") {
        if (text[i + 1] === "'") {
          out.push(ch, ch);
          i++;
        } else {
          inSingle = false;
          out.push(ch);
        }
        continue;
      }
      out.push(ch);
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\n")) {
      // A comment: copy it verbatim to the end of the line, quotes and all.
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out.push(text.slice(i, stop));
      i = stop - 1;
      continue;
    }
    out.push(ch);
  }

  if (inDouble) return null;
  return changed ? out.join("") : null;
}

/**
 * What each illegal raw character becomes. TAB is deliberately absent: it is a
 * printable character in YAML and needs no escape.
 */
const CONTROL_ESCAPES: Readonly<Record<string, string>> = {
  "\n": "\\n",
  "\r": "\\r",
  "\v": "\\v",
  "\f": "\\f",
  "\u0000": "\\0",
  "\u0007": "\\a",
  "\b": "\\b",
  "\u001b": "\\e",
  "\u0085": "\\N",
  "\u2028": "\\L",
  "\u2029": "\\P",
};
