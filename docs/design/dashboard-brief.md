# Design brief — tldrx dashboard (read-only)

Paste this into Claude Design together with `docs/dashboard-model.md` and a fresh `model.json`
(`tldrx dashboard` → `curl -s http://127.0.0.1:4477/model.json > model.json`). The current page is
the reference for *content*, not for *look*: `.tldrx/cache/dashboard/index.html`.

## What it is

A local, read-only status page for **tldr-experts (tldrx)** — a file-based AI development workflow.
Every fact on the page comes from files on disk (`run.yml`, `events.jsonl`, handoffs, questions,
expert competencies). The page must render entirely from one JSON document (`model.json`, shape in
`docs/dashboard-model.md`) — nothing else is available to it, and nothing can be launched from it.

## Who reads it

1. A non-technical stakeholder who wants a tl;dr: what is being built, where it stands, what is
   waiting on a human, how much it has cost.
2. A developer who wants the next command to run (`tldrx next`, `tldrx answer Q4 …`, `tldrx approve`)
   and the evidence behind a stage (handoff, questions, citations).

## Pages / views (all from the same model)

- **Runs** — list: id, title, scope, status, phase progress, spent / ceiling, the one thing waiting
  (a pending question or a gate). Sortable by updated time; a status filter.
- **Run detail** — header (scope, repos, cost, status), the execution path (phase → stage → expert →
  model → cost → gate), the stage's handoff rendered (Findings / Decisions / Unknowns / Evidence
  ledger, every bullet ends with a `[src: …]` citation — treat citations as first-class UI, not
  noise), open questions with their options, and when present the Plan (epics, stories, waves) and
  Build progress (per story: status, cost, evidence).
- **Experts** — per expert: status, last trained, a star/radar chart of competency levels
  (0–5, *computed from evidence*), evidence counts and dates, and a copy-paste "train me" command.
- **Watchers** — one card per shipped feature: signal, where to look, healthy baseline, "looks
  broken when", a copy-paste query, status draft/verified.
- **FAQ / How to use** — short, with copy-paste commands.

## Hard constraints

- **Read-only.** No buttons that change anything. Copy-to-clipboard is fine.
- **Self-contained.** One HTML file: inline CSS/JS/SVG, no CDN, no external fonts or images
  (it also runs offline and inside a sandboxed viewer).
- **Theme-aware**: light and dark via `prefers-color-scheme`; must stay legible in both.
- **Renders from `model.json` client-side**; the server only pushes a `reload` over SSE.
  Keep data model and renderer separate — the model is the contract, the renderer is yours.
- **Live-updating without jank**: a re-render every few seconds must not lose scroll position or
  an expanded panel (stable ids / keys).
- **Responsive** down to a phone; wide tables scroll inside their container.
- Accessibility: keyboard-navigable, contrast ≥ WCAG AA, charts have text equivalents.
- No framework required; if you propose one, it must be vendorable into a single file.

## Tone

Calm, dense, factual. Numbers and citations over decoration. Think "flight-status board" more than
"marketing dashboard". Alerts only for the two states that need a human: a pending question and a
pending gate.

## Deliverables

1. Visual design of the five views (light + dark), desktop and phone.
2. A component inventory mapped to model fields (`docs/dashboard-model.md` names), so the renderer
   can be rewritten one component at a time.
3. Design tokens (colors, type scale, spacing) as CSS custom properties.
4. Optionally, a static HTML/CSS prototype that renders the attached `model.json`.
