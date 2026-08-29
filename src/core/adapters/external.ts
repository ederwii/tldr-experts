/**
 * The two front-matter keys the ticket mirror owns, and the hard rule that it
 * owns ONLY those two.
 *
 * `external:` is the remote identity (guard-rail 1's "mirrors out");
 * `external_status:` is the remote's own status string pulled back in
 * (guard-rail 1's "pulls external status in"). Nothing else in the file is
 * touched — the edit is surgical, exactly as `build/storyFile.ts` is surgical,
 * because a story is a document a human wrote and a round-trip through YAML would
 * reflow their comments and quoting.
 *
 * **`status:` is never written here.** `applyExternal` asserts it, by rebuilding
 * the front matter from the original lines and refusing any patch that would
 * change the `status:` line. That is guard-rail 2 in executable form: filing a
 * ticket is not "done", and this module is structurally incapable of saying it is.
 */
import { parseYaml } from "../yaml.ts";
import { FENCE, splitFrontMatter } from "../schemas/frontMatter.ts";
import { TicketAdapterError, type ExternalRef } from "./types.ts";

export const EXTERNAL_KEY = "external";
export const EXTERNAL_STATUS_KEY = "external_status";

const EXTERNAL_RE = /^external\s*:/;
const EXTERNAL_STATUS_RE = /^external_status\s*:/;
const STATUS_RE = /^status\s*:/;
const INDENTED_RE = /^\s+\S/;

export interface ExternalFields {
  readonly external: ExternalRef | null;
  /** Verbatim remote status, or null when nothing has been pulled yet. */
  readonly externalStatus: string | null;
}

/** Read the two keys out of a story's or epic's front matter. Never throws. */
export function readExternal(text: string): ExternalFields {
  const split = splitFrontMatter(text);
  if (!split.present) return { external: null, externalStatus: null };
  let doc: unknown;
  try {
    doc = parseYaml(split.raw);
  } catch {
    return { external: null, externalStatus: null };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { external: null, externalStatus: null };
  }
  const record = doc as Record<string, unknown>;
  return { external: asExternalRef(record[EXTERNAL_KEY]), externalStatus: asStatus(record[EXTERNAL_STATUS_KEY]) };
}

function asExternalRef(value: unknown): ExternalRef | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  const key = record.key;
  const url = record.url;
  const syncedAt = record.synced_at;
  if (typeof provider !== "string" || typeof url !== "string" || typeof syncedAt !== "string") return null;
  // A GitHub issue number reads back from YAML as a number; a Jira key as a
  // string. Both are the same identity, so both are accepted and normalised.
  if (typeof key !== "string" && typeof key !== "number") return null;
  return { provider, key: String(key), url, synced_at: syncedAt };
}

function asStatus(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  return null;
}

export interface ExternalPatch {
  readonly external?: ExternalRef;
  /** `null` clears the key; omitted leaves whatever is there. */
  readonly externalStatus?: string | null;
}

/**
 * Write the patch into the front matter and return the whole file.
 *
 * Existing keys are replaced in place (so the file keeps its key order across
 * syncs and re-syncing is a no-op diff); absent keys are appended to the end of
 * the front matter.
 */
export function applyExternal(text: string, patch: ExternalPatch): string {
  const split = splitFrontMatter(text);
  if (!split.present) {
    throw new TicketAdapterError("no `---` front matter to mirror into");
  }
  const before = split.raw.split("\n");
  const statusBefore = before.find((line) => STATUS_RE.test(line));

  let lines = before;
  if (patch.external !== undefined) lines = replaceBlock(lines, EXTERNAL_RE, externalBlock(patch.external));
  if (patch.externalStatus !== undefined) {
    lines = replaceBlock(
      lines,
      EXTERNAL_STATUS_RE,
      patch.externalStatus === null ? [] : [`${EXTERNAL_STATUS_KEY}: ${quote(patch.externalStatus)}`],
    );
  }

  // Guard-rail 2, enforced rather than promised.
  const statusAfter = lines.find((line) => STATUS_RE.test(line));
  if (statusAfter !== statusBefore) {
    throw new TicketAdapterError(
      "the ticket mirror tried to change `status:` — it may only write `external` and `external_status`",
    );
  }
  return [FENCE, ...lines, FENCE, split.body].join("\n");
}

/**
 * Replace the key matched by `re` — and the indented block under it — with
 * `block`. Appends at the end when the key is absent and `block` is non-empty.
 */
function replaceBlock(lines: readonly string[], re: RegExp, block: readonly string[]): string[] {
  const out = [...lines];
  const at = out.findIndex((line) => re.test(line));
  if (at === -1) {
    if (block.length === 0) return out;
    // Drop a single trailing blank line so the append does not grow one each sync.
    while (out.length > 0 && (out[out.length - 1] ?? "").trim() === "") out.pop();
    return [...out, ...block];
  }
  let end = at + 1;
  while (end < out.length && INDENTED_RE.test(out[end] ?? "")) end++;
  out.splice(at, end - at, ...block);
  return out;
}

function externalBlock(ref: ExternalRef): readonly string[] {
  return [
    `${EXTERNAL_KEY}:`,
    `  provider: ${quote(ref.provider)}`,
    `  key: ${quote(ref.key)}`,
    `  url: ${quote(ref.url)}`,
    `  synced_at: ${quote(ref.synced_at)}`,
  ];
}

/** JSON's escaping is a subset of YAML's, so this reads back byte-identical. */
function quote(value: string): string {
  return JSON.stringify(value);
}
