/**
 * The star chart as inline SVG — the same numbers `expert list` prints, drawn.
 *
 * Inline and geometric on purpose: no icon font, no sprite sheet, no external
 * request. Coordinates are rounded to two decimals so the same competencies.yml
 * always produces byte-identical markup.
 */
import { escapeHtml } from "../markdown/index.ts";
import { MAX_LEVEL } from "../experts/index.ts";
import type { AreaRecord } from "../experts/index.ts";

const STAR_R = 8;
const STEP = 22;
const ROW_H = 26;
const LABEL_W = 150;

export function starPoints(cx: number, cy: number, radius: number): string {
  const points: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? radius : radius * 0.4;
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    points.push(`${round(cx + r * Math.cos(angle))},${round(cy + r * Math.sin(angle))}`);
  }
  return points.join(" ");
}

/** One row per area: label, five stars, the level, the evidence count. */
export function starSvg(areas: readonly AreaRecord[]): string {
  if (areas.length === 0) {
    return '<p class="note">No areas yet — training is what gives an expert evidence.</p>';
  }
  const width = LABEL_W + STEP * MAX_LEVEL + 120;
  const height = ROW_H * areas.length + 8;
  const parts: string[] = [
    // No `xmlns`: this is inline SVG inside an HTML document, and the export
    // must contain no URL of any kind, namespace identifiers included.
    `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" `
      + `aria-label="Competency star chart">`,
  ];

  areas.forEach((area, row) => {
    const y = row * ROW_H + ROW_H / 2;
    parts.push(
      `<text x="0" y="${round(y + 4)}" font-size="12" font-family="ui-monospace, Menlo, Consolas, monospace" `
        + `fill="currentColor">${escapeHtml(area.id)}</text>`,
    );
    for (let i = 0; i < MAX_LEVEL; i++) {
      const cx = LABEL_W + i * STEP + STAR_R;
      const filled = i < area.level;
      parts.push(
        `<polygon points="${starPoints(cx, y, STAR_R)}" fill="${filled ? "currentColor" : "none"}" `
          + `stroke="currentColor" stroke-width="1" opacity="${filled ? "1" : "0.35"}" />`,
      );
    }
    parts.push(
      `<text x="${LABEL_W + STEP * MAX_LEVEL + 8}" y="${round(y + 4)}" font-size="12" fill="currentColor" `
        + `opacity="0.75">${area.level}/${MAX_LEVEL} · ${area.evidence.length} evidence</text>`,
    );
  });

  parts.push("</svg>");
  return parts.join("");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
