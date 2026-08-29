/**
 * Keep the export URL-free without losing a citation.
 *
 * Handoffs cite vendor docs by https URL (spec §2.8), and the Markdown converter
 * turns `[label](https://…)` into an anchor. The dashboard must contain no
 * external URL in any `href`/`src`, so those anchors are demoted to inline code
 * that still SHOWS the URL — the reader can copy it, the page never fetches it,
 * and no evidence disappears from the page to satisfy a rule.
 */

const EXTERNAL_ANCHOR = /<a href="(https:\/\/[^"]*)">([\s\S]*?)<\/a>/g;

export function offlineHtml(html: string): string {
  return html.replace(EXTERNAL_ANCHOR, (_match, href: string, label: string) => {
    const text = stripTags(label);
    return text === "" || text === href ? `<code>${href}</code>` : `<code>${text} → ${href}</code>`;
  });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}
