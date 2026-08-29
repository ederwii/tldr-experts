/**
 * Block-level Markdown -> HTML, deterministic and dependency-free.
 *
 * Supports exactly what the framework's own artefacts use: ATX headings,
 * paragraphs, `-`/`*` bullet lists, fenced code blocks, and the inline set from
 * `renderInline`. Anything else (tables, blockquotes, images) falls through as a
 * paragraph rather than being silently dropped — an unrendered claim is still a
 * readable claim, a disappeared one is a lie.
 */
import { escapeHtml } from "./escapeHtml.ts";
import { renderInline } from "./renderInline.ts";

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^\s{0,3}[-*]\s+(.*)$/;
const FENCE_RE = /^\s{0,3}```(\S*)\s*$/;

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];

  const closeParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeList = (): void => {
    if (bullets.length === 0) return;
    out.push(`<ul>${bullets.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
    bullets = [];
  };
  const closeBlocks = (): void => {
    closeParagraph();
    closeList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      closeBlocks();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && FENCE_RE.exec(lines[i] ?? "") === null) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      const language = fence[1] ?? "";
      const attribute = language === "" ? "" : ` class="language-${escapeHtml(language)}"`;
      out.push(`<pre><code${attribute}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (line.trim() === "") {
      closeBlocks();
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      closeBlocks();
      const level = (heading[1] ?? "#").length;
      out.push(`<h${level}>${renderInline(heading[2] ?? "")}</h${level}>`);
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet !== null) {
      closeParagraph();
      bullets.push(bullet[1] ?? "");
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  closeBlocks();
  return out.join("\n");
}
