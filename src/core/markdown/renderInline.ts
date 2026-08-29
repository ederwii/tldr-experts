/**
 * Inline Markdown: code spans, links, bold.
 *
 * A left-to-right scanner rather than a chain of regex passes, so a `**bold**`
 * inside backticks stays literal and nothing is ever double-escaped. Deliberately
 * tiny: this renders artefacts the framework itself wrote (handoffs, questions,
 * expert files), so a full CommonMark implementation would be a runtime
 * dependency bought for nothing.
 */
import { escapeHtml } from "./escapeHtml.ts";

/**
 * `[assumption]` Only `https://` and in-page `#` targets become anchors; anything
 * else is left as literal text. The dashboard is a self-contained file with no
 * external requests of any kind, and `http://` is rejected by the spec's own src
 * grammar (§2.8), so an anchor that could reach out is never emitted here either.
 */
const SAFE_HREF = /^(https:\/\/|#)/;

export function renderInline(text: string): string {
  let out = "";
  let plain = "";

  const flush = (): void => {
    if (plain !== "") out += escapeHtml(plain);
    plain = "";
  };

  for (let i = 0; i < text.length; ) {
    const char = text[i] ?? "";

    if (char === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out += `<code>${escapeHtml(text.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }

    if (char === "*" && text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out += `<strong>${renderInline(text.slice(i + 2, end))}</strong>`;
        i = end + 2;
        continue;
      }
    }

    if (char === "[") {
      const link = matchLink(text, i);
      if (link !== null) {
        flush();
        out += SAFE_HREF.test(link.href)
          ? `<a href="${escapeHtml(link.href)}">${renderInline(link.label === "" ? link.href : link.label)}</a>`
          : escapeHtml(text.slice(i, link.next));
        i = link.next;
        continue;
      }
    }

    plain += char;
    i += 1;
  }

  flush();
  return out;
}

interface LinkMatch {
  readonly label: string;
  readonly href: string;
  /** Index just past the closing paren. */
  readonly next: number;
}

function matchLink(text: string, start: number): LinkMatch | null {
  const close = text.indexOf("]", start + 1);
  if (close === -1 || text[close + 1] !== "(") return null;
  const paren = text.indexOf(")", close + 2);
  if (paren === -1) return null;
  const href = text.slice(close + 2, paren);
  if (href === "" || /\s/.test(href)) return null;
  return { label: text.slice(start + 1, close), href, next: paren + 1 };
}
