/**
 * The pack grammar (stack packs design §4.1) and the one composition rule (§4.5).
 *
 * A pack — a language body or a framework overlay — has exactly two H2s. Defaults apply
 * only when the repo is silent on the topic and each one names the signal that overrides
 * it; Checks are asked of every review and a miss is a finding with a cited file, with the
 * project's own convention as the accepted answer when it exists. Measured repo
 * conventions win over pack content, always (decision 1).
 *
 * These two heading strings are spelled here and nowhere else: the templates carry them,
 * the shape test asserts them, the reviewer extracts by them.
 *
 * Composition is ATOMIC per overlay: the pack body is always included in full, then each
 * overlay is appended WHOLE, in sorted-id order, while the running total stays under the
 * cap. The first overlay that does not fit — and every later one in that order — is left
 * out entirely and named in a trailing marker; nothing is cut mid-overlay. `truncateAtHeading`
 * cuts at ANY `## ` line, including an overlay's own `## Defaults`/`## Checks`, so it is
 * applied only to the body itself, and only defensively (a body is capped at 8 KiB by a
 * shape test, well under the 24 KiB pack cap, so this only matters for a caller-supplied
 * `maxBytes` far smaller than that).
 *
 * `ComposedPack.truncated` reports ONLY whether that body cut happened — an overlay left
 * out whole is not "truncated", it's "not inlined", and `notInlined` already says so. A
 * caller that wants "was anything left out at all" checks both.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { section, splitFrontMatter } from "./expertDocument.ts";
import { byteLength, truncateAtHeading } from "./expertKnowledge.ts";

export const DEFAULTS_HEADING = "Defaults (when the repo is silent)";
export const CHECKS_HEADING = "Checks (always asked in review)";
/** Every Default bullet ends with this and the signal that overrides it. */
export const OVERRIDDEN_BY = "— overridden by:";
/** Every Check bullet carries this and what to open or run. */
export const VERIFY_HINT = "verify:";

/** `.tldrx/experts/<lang>-stack/overlays/` — framework-managed, rewritten on enable and re-init. */
export const OVERLAYS_DIRNAME = "overlays";

/**
 * `[assumption]` 24 KB for body + overlays together, per stack expert. Separate from the
 * 48 KB trained-knowledge budget on purpose: pack prose must not crowd out what training
 * found (§3). A body is ≤ 8 KB and an overlay ≤ 6 KB, so two or three overlays fit whole.
 */
export const PACK_MAX_BYTES = 24 * 1024;

export interface OverlayFile {
  readonly id: string;
  readonly text: string;
}

export function overlayMarker(id: string): string {
  return `<!-- overlay: ${id} -->`;
}

export interface ComposedPack {
  readonly text: string;
  readonly inlined: readonly string[];
  readonly notInlined: readonly string[];
  /**
   * Whether the BODY ITSELF was cut by `truncateAtHeading` — not whether any overlay was
   * left out. An overlay left out whole is already fully described by `notInlined` being
   * non-empty; nothing there was cut, so folding it into `truncated` would call "left out
   * whole" the same thing as "cut in half", and would make a real body cut unobservable
   * whenever it happened to coincide with a dropped overlay. A caller that wants "was
   * anything left out, cut or whole" combines `truncated || notInlined.length > 0` itself.
   */
  readonly truncated: boolean;
}

/**
 * `body + overlays/*.md`, sorted by id, appended whole under `maxBytes`. Overlays that do
 * not fit — and every later one in sorted order, never a smaller one skipped ahead to — are
 * named in a trailing `(not inlined: …)` marker instead of being cut. The body itself is
 * always included; `truncateAtHeading` only ever trims the body, and only when the body
 * alone already exceeds `maxBytes` (defensive — see module doc).
 */
export function composePackBody(
  body: string,
  overlays: readonly OverlayFile[],
  maxBytes: number = PACK_MAX_BYTES,
): ComposedPack {
  const sorted = [...overlays].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const fullBody = `${body.trimEnd()}\n`;
  let bodyText = fullBody;
  if (byteLength(fullBody) > maxBytes) {
    const cut = truncateAtHeading(fullBody, maxBytes);
    bodyText = cut === "" ? fullBody : cut;
  }
  const bodyTruncated = byteLength(bodyText) < byteLength(fullBody);

  const inlined: string[] = [];
  const notInlined: string[] = [];
  const parts: string[] = [bodyText.trimEnd()];
  let total = byteLength(bodyText);
  let pastCap = false;

  for (const overlay of sorted) {
    if (pastCap) {
      notInlined.push(overlay.id);
      continue;
    }
    const piece = `${overlayMarker(overlay.id)}\n${overlay.text.trimEnd()}`;
    const added = byteLength("\n\n") + byteLength(piece);
    if (total + added > maxBytes) {
      pastCap = true;
      notInlined.push(overlay.id);
      continue;
    }
    total += added;
    inlined.push(overlay.id);
    parts.push(piece);
  }

  const composedText = `${parts.join("\n\n")}\n`;
  const truncated = bodyTruncated;

  if (notInlined.length === 0) {
    return { text: composedText, inlined, notInlined, truncated };
  }

  const noun = notInlined.length === 1 ? "overlay" : "overlays";
  const marker = `(not inlined: ${String(notInlined.length)} ${noun} — ${notInlined.join(", ")})`;
  return {
    text: `${composedText.trimEnd()}\n\n${marker}\n`,
    inlined,
    notInlined,
    truncated,
  };
}

/** The `## Checks (always asked in review)` section of a pack or overlay; `""` when it has none. */
export function checksOf(text: string): string {
  return section(splitFrontMatter(text).body, CHECKS_HEADING);
}

/** `overlays/*.md` under one expert folder, sorted by id. Missing folder ⇒ empty. */
export function readOverlayFiles(expertDirAbs: string): readonly OverlayFile[] {
  const dir = join(expertDirAbs, OVERLAYS_DIRNAME);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .map((entry) => ({ id: entry.replace(/\.md$/, ""), text: readFileSync(join(dir, entry), "utf8") }));
}
