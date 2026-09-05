/**
 * Where the shipped packs live and how a shipment is named.
 *
 * `templates/experts/stack/<lang>.md` is a language pack body; `overlays/<id>.md` is a
 * framework overlay. Both ship in the npm package (`files: templates`) and are read from
 * `TEMPLATES_DIR` at run time, exactly as role bodies are. `pack: <lang>@<hash>` in a
 * materialised expert's front matter names one exact shipment: the hash covers every
 * template's path and bytes, so a changed template is a different hash.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATES_DIR } from "../paths.ts";
import type { PackLanguage } from "../detect/overlays.ts";

export const PACK_TEMPLATES_DIR: string = join(TEMPLATES_DIR, "experts", "stack");
export const OVERLAY_TEMPLATES_DIR: string = join(PACK_TEMPLATES_DIR, "overlays");

/** Caps a shape test enforces (stack packs design §4.1). */
export const PACK_BODY_MAX_BYTES = 8 * 1024;
export const OVERLAY_MAX_BYTES = 6 * 1024;

export function packBodyPath(lang: PackLanguage): string {
  return join(PACK_TEMPLATES_DIR, `${lang}.md`);
}

export function overlayTemplatePath(id: string): string {
  return join(OVERLAY_TEMPLATES_DIR, `${id}.md`);
}

/** The shipped body for a language, or null when none ships — the caller says so, never guesses. */
export function readPackBody(lang: PackLanguage): string | null {
  const path = packBodyPath(lang);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function readOverlayTemplate(id: string): string | null {
  const path = overlayTemplatePath(id);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export interface TemplateFile {
  /** Relative to `PACK_TEMPLATES_DIR`, POSIX: `typescript.md`, `overlays/react.md`. */
  readonly rel: string;
  readonly abs: string;
}

/** Every shipped `.md` under the pack templates dir, sorted by `rel`. Missing dir ⇒ empty. */
export function packTemplateFiles(): readonly TemplateFile[] {
  const out: TemplateFile[] = [];
  if (!existsSync(PACK_TEMPLATES_DIR)) return out;
  for (const entry of readdirSync(PACK_TEMPLATES_DIR).sort()) {
    if (entry.endsWith(".md")) out.push({ rel: entry, abs: join(PACK_TEMPLATES_DIR, entry) });
  }
  if (existsSync(OVERLAY_TEMPLATES_DIR)) {
    for (const entry of readdirSync(OVERLAY_TEMPLATES_DIR).sort()) {
      if (entry.endsWith(".md")) out.push({ rel: `overlays/${entry}`, abs: join(OVERLAY_TEMPLATES_DIR, entry) });
    }
  }
  return out;
}

/** First 12 hex of sha256 over `rel\n<text>\n` for every entry, in the given order. */
export function hashTemplates(entries: readonly { readonly rel: string; readonly text: string }[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(`${entry.rel}\n${entry.text}\n`);
  return hash.digest("hex").slice(0, 12);
}

export function templatesHash(): string {
  return hashTemplates(packTemplateFiles().map((file) => ({ rel: file.rel, text: readFileSync(file.abs, "utf8") })));
}
