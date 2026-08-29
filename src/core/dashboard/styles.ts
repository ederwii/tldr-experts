/**
 * The dashboard's entire stylesheet, inlined.
 *
 * No external URLs of any kind — no CDN, no font host, no image host — because
 * the export is a single file meant to be mailed, committed or opened offline.
 * Colours are tokens on `:root`, redefined once under `prefers-color-scheme:
 * dark`, so the page follows the reader's theme rather than picking one for them.
 */
export const DASHBOARD_CSS = `
:root {
  --bg: #fbfbfa; --panel: #ffffff; --ink: #1b1b1a; --muted: #6b6b68;
  --line: #e3e3df; --accent: #2f5d50; --accent-ink: #ffffff;
  --warn: #8a5a00; --bad: #9b2c2c; --ok: #2f6f4f; --code-bg: #f2f2ee;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181a; --panel: #1e2124; --ink: #e8e8e4; --muted: #9a9a95;
    --line: #303539; --accent: #7fbfa8; --accent-ink: #11201b;
    --warn: #e0a955; --bad: #e08585; --ok: #7fbfa8; --code-bg: #14181b;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); line-height: 1.55; }
header.top { border-bottom: 1px solid var(--line); padding: 1.2rem 1.5rem; background: var(--panel); }
header.top h1 { margin: 0 0 .2rem; font-size: 1.25rem; letter-spacing: -.01em; }
header.top p { margin: 0; color: var(--muted); font-size: .85rem; }
nav.top { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: .8rem; }
nav.top a { color: var(--accent); text-decoration: none; font-size: .85rem; border: 1px solid var(--line); border-radius: 999px; padding: .15rem .7rem; }
main { max-width: 62rem; margin: 0 auto; padding: 1.5rem; }
section { margin-bottom: 2.5rem; }
h2 { font-size: 1.05rem; border-bottom: 1px solid var(--line); padding-bottom: .35rem; margin-top: 2rem; }
h3 { font-size: .95rem; margin: 1.4rem 0 .4rem; }
h4 { font-size: .85rem; margin: 1rem 0 .3rem; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.1rem; margin-bottom: 1rem; }
.meta { color: var(--muted); font-size: .82rem; }
.pill { display: inline-block; font-size: .72rem; padding: .05rem .5rem; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.pill.wait { color: var(--warn); border-color: var(--warn); }
.pill.bad { color: var(--bad); border-color: var(--bad); }
.pill.ok { color: var(--ok); border-color: var(--ok); }
.bar { height: 8px; background: var(--code-bg); border-radius: 999px; overflow: hidden; margin: .5rem 0 .3rem; }
.bar > span { display: block; height: 100%; background: var(--accent); }
table { border-collapse: collapse; width: 100%; font-size: .85rem; }
th, td { text-align: left; padding: .35rem .55rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; }
code { font-family: var(--mono); font-size: .85em; background: var(--code-bg); padding: .05rem .3rem; border-radius: 4px; }
pre { font-family: var(--mono); font-size: .8rem; background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px; padding: .8rem; overflow-x: auto; }
pre code { background: none; padding: 0; }
ul { padding-left: 1.1rem; }
a { color: var(--accent); }
.scroll { overflow-x: auto; }
.grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); }
.filter { font: inherit; font-size: .85rem; padding: .3rem .6rem; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--ink); width: 100%; max-width: 22rem; }
.hidden { display: none; }
.handoff { font-size: .88rem; }
.handoff h2, .handoff h3 { border: none; margin: .8rem 0 .3rem; font-size: .9rem; }
.note { color: var(--muted); font-size: .8rem; font-style: italic; }
footer { border-top: 1px solid var(--line); padding: 1rem 1.5rem; color: var(--muted); font-size: .78rem; }
`.trim();
