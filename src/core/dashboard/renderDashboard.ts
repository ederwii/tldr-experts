/**
 * `tldrx dashboard --static` — one self-contained `index.html`.
 *
 * Concept §12: read-only. It shows runs, the execution path, the handoffs, the
 * open questions, the experts and how to drive the loop from a terminal — and it
 * has no control that changes anything, because a dashboard that can launch work
 * is a second source of truth competing with the files.
 *
 * Self-contained means self-contained: CSS and JS are inlined, charts are inline
 * SVG, and the document contains no `http://` or `https://` reference at all, so
 * it renders identically offline and leaks nothing about who opened it.
 */
import { basename } from "node:path";
import { escapeHtml, renderMarkdown } from "../markdown/index.ts";
import { driftWarnings, type ExpertRecord } from "../experts/index.ts";
import { money } from "../replay/index.ts";
import { DASHBOARD_CSS } from "./styles.ts";
import { DASHBOARD_JS } from "./script.ts";
import { offlineHtml } from "./offlineHtml.ts";
import { starSvg } from "./starSvg.ts";
import type { DashboardData, RunView } from "./collect.ts";
import type { QuestionBlock } from "../text/index.ts";

export const DASHBOARD_TITLE = "tldrx dashboard";

export function renderDashboard(data: DashboardData): string {
  const parts: string[] = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(DASHBOARD_TITLE)} — ${escapeHtml(basename(data.root))}</title>`,
    `<style>${DASHBOARD_CSS}</style>`,
    "</head>",
    "<body>",
    header(data),
    "<main>",
    runsSection(data),
    ...data.runs.map(runDetail),
    expertsSection(data.experts),
    faqSection(),
    "</main>",
    footer(data),
    `<script>${DASHBOARD_JS}</script>`,
    "</body>",
    "</html>",
  ];
  return `${parts.join("\n")}\n`;
}

function header(data: DashboardData): string {
  return [
    '<header class="top">',
    `<h1>tldrx — ${escapeHtml(basename(data.root))}</h1>`,
    `<p>Read-only snapshot generated ${escapeHtml(data.generatedAt)} · `
      + `${data.runs.length} run${data.runs.length === 1 ? "" : "s"} · `
      + `${data.experts.length} expert${data.experts.length === 1 ? "" : "s"}. `
      + "Nothing on this page changes anything.</p>",
    '<nav class="top">',
    '<a href="#runs">Runs</a>',
    ...data.runs.map((run) => `<a href="#run-${escapeHtml(run.loaded.id)}">${escapeHtml(run.loaded.id)}</a>`),
    '<a href="#experts">Experts</a>',
    '<a href="#faq">How to use</a>',
    "</nav>",
    "</header>",
  ].join("\n");
}

function runsSection(data: DashboardData): string {
  if (data.runs.length === 0) {
    return [
      '<section id="runs">',
      "<h2>Runs</h2>",
      '<p class="note">No runs yet. <code>tldrx run new --scope feature</code> opens one.</p>',
      "</section>",
    ].join("\n");
  }

  const cards = data.runs.map((run) => {
    const doc = run.loaded.run;
    const pct = run.stagesTotal === 0 ? 0 : Math.round((run.stagesDone / run.stagesTotal) * 100);
    const waiting: string[] = [];
    if (run.pendingGate !== null) {
      waiting.push(`<span class="pill wait">gate pending: ${escapeHtml(run.pendingGate)}</span>`);
    }
    if (run.pendingQuestion !== null) {
      waiting.push(`<span class="pill wait">question open: ${escapeHtml(run.pendingQuestion)}</span>`);
    }
    if (waiting.length === 0) waiting.push('<span class="pill ok">nothing pending</span>');

    const haystack = [doc.run, doc.title, doc.scope, doc.status].join(" ");
    return [
      `<div class="card" data-run-row="${escapeHtml(haystack)}">`,
      `<h3><a href="#run-${escapeHtml(run.loaded.id)}">${escapeHtml(doc.run)}</a> — `
        + `${escapeHtml(doc.title === "" ? "(untitled)" : doc.title)}</h3>`,
      `<p class="meta">scope <code>${escapeHtml(doc.scope || "?")}</code> · `
        + `status <strong>${escapeHtml(doc.status || "unknown")}</strong> · `
        + `${escapeHtml(money(doc.spent_usd))} of ${escapeHtml(money(doc.ceiling_usd))}</p>`,
      `<div class="bar"><span style="width:${pct}%"></span></div>`,
      `<p class="meta">${run.stagesDone} of ${run.stagesTotal} stages terminal (${pct}%)</p>`,
      `<p>${waiting.join(" ")}</p>`,
      "</div>",
    ].join("\n");
  });

  return [
    '<section id="runs">',
    "<h2>Runs</h2>",
    '<p><input id="run-filter" class="filter" type="text" placeholder="filter runs…" '
      + 'aria-label="Filter runs"></p>',
    ...cards,
    "</section>",
  ].join("\n");
}

function runDetail(run: RunView): string {
  const doc = run.loaded.run;
  const rows: string[] = [];
  for (const phase of doc.phases) {
    for (const stage of phase.stages) {
      rows.push([
        "<tr>",
        `<td><code>${escapeHtml(phase.id)}</code></td>`,
        `<td><code>${escapeHtml(stage.id)}</code></td>`,
        `<td>${escapeHtml(stage.status)}</td>`,
        `<td>${escapeHtml(stage.expert ?? "—")}</td>`,
        `<td>${escapeHtml(stage.model ?? "—")}</td>`,
        `<td>${escapeHtml(money(stage.cost_usd))} / ${escapeHtml(money(stage.budget_usd))}</td>`,
        `<td>${escapeHtml(stage.gate === null ? "—" : `${stage.gate.type}: ${stage.gate.status}`)}</td>`,
        "</tr>",
      ].join(""));
    }
  }

  const cursor = doc.cursor === null
    ? "no cursor recorded"
    : `${doc.cursor.phase} / ${doc.cursor.stage}`;

  const sections: string[] = [
    `<section id="run-${escapeHtml(run.loaded.id)}">`,
    `<h2>${escapeHtml(doc.run)} — ${escapeHtml(doc.title === "" ? "(untitled)" : doc.title)}</h2>`,
    `<p class="meta">workflow <code>${escapeHtml(doc.workflow || "?")}</code> · `
      + `repos ${escapeHtml(doc.repos.join(", ") || "—")} · cursor <code>${escapeHtml(cursor)}</code> · `
      + `updated ${escapeHtml(doc.updated_at ?? "—")}</p>`,
    "<h3>Execution path</h3>",
    '<div class="scroll"><table>',
    "<thead><tr><th>phase</th><th>stage</th><th>status</th><th>expert</th><th>model</th>"
      + "<th>cost / ceiling</th><th>gate</th></tr></thead>",
    `<tbody>${rows.join("")}</tbody>`,
    "</table></div>",
  ];

  for (const phase of run.phases) {
    if (phase.handoff === null && phase.questions.length === 0) continue;
    sections.push(`<h3>${escapeHtml(phase.id)}</h3>`);
    if (phase.handoff !== null) {
      sections.push(`<div class="card handoff">${offlineHtml(renderMarkdown(phase.handoff))}</div>`);
    }
    for (const question of phase.questions) sections.push(questionCard(question));
  }

  sections.push("</section>");
  return sections.join("\n");
}

function questionCard(question: QuestionBlock): string {
  const options = question.options.length === 0
    ? ""
    : `<ul>${question.options
        .map((option) => `<li><strong>${escapeHtml(option.letter)})</strong> ${escapeHtml(option.text)}</li>`)
        .join("")}</ul>`;
  return [
    '<div class="card">',
    `<h4>Open question ${escapeHtml(question.id)}</h4>`,
    `<p><strong>${escapeHtml(question.title)}</strong></p>`,
    question.whyAsked === null ? "" : `<p class="meta">${escapeHtml(question.whyAsked)}</p>`,
    options,
    `<pre><code>tldrx answer ${escapeHtml(question.id)} "your answer"</code></pre>`,
    "</div>",
  ].filter((line) => line !== "").join("\n");
}

function expertsSection(experts: readonly ExpertRecord[]): string {
  if (experts.length === 0) {
    return [
      '<section id="experts">',
      "<h2>Experts</h2>",
      '<p class="note">No experts yet. <code>tldrx init</code> seeds them; '
        + "<code>tldrx expert create &lt;name&gt;</code> adds one.</p>",
      "</section>",
    ].join("\n");
  }

  const cards = experts.map((expert) => {
    const warnings = driftWarnings(expert);
    return [
      '<div class="card">',
      `<h3>${escapeHtml(expert.name)} <span class="pill">${escapeHtml(expert.status)}</span></h3>`,
      `<p class="meta">last trained ${escapeHtml(expert.lastTrained ?? "never")} · `
        + `${expert.areas.length} area${expert.areas.length === 1 ? "" : "s"} · `
        + "levels computed from evidence (spec §2.6)</p>",
      expert.error === null ? "" : `<p class="pill bad">unreadable: ${escapeHtml(expert.error)}</p>`,
      starSvg(expert.areas),
      ...warnings.map((warning) => `<p class="pill wait">${escapeHtml(warning)}</p>`),
      expert.areas.length === 0
        ? ""
        : "<h4>Train me on…</h4>"
          + expert.areas
            .map((area) => `<pre><code>${escapeHtml(area.trainPrompt)} --print-prompt</code></pre>`)
            .join(""),
      "</div>",
    ].filter((line) => line !== "").join("\n");
  });

  return ['<section id="experts">', "<h2>Experts</h2>", ...cards, "</section>"].join("\n");
}

function faqSection(): string {
  return [
    '<section id="faq">',
    "<h2>How to use this</h2>",
    "<p>The files are the product; this page is a window onto them. Everything below is run "
      + "in a terminal at the workspace root.</p>",
    "<h4>Open a piece of work</h4>",
    "<pre><code>tldrx run new --scope feature --budget 25</code></pre>",
    "<h4>Run the next stage — it stops at gates and questions</h4>",
    "<pre><code>tldrx next</code></pre>",
    "<h4>Answer an open question</h4>",
    '<pre><code>tldrx answer Q4 "rankings are global, same as Places"</code></pre>',
    "<h4>Approve or reject the stage waiting at a gate</h4>",
    "<pre><code>tldrx approve --note \"contracts look right\"\ntldrx reject --note \"split the migration out\"</code></pre>",
    "<h4>Read the story of a run</h4>",
    "<pre><code>tldrx replay 260828-leaderboard</code></pre>",
    "<h4>Regenerate this page</h4>",
    "<pre><code>tldrx dashboard --static</code></pre>",
    '<p class="note">Why is nothing clickable? Because the run is the files. A button here '
      + "would be a second way to change state, and then neither would be the truth.</p>",
    "</section>",
  ].join("\n");
}

function footer(data: DashboardData): string {
  return [
    "<footer>",
    `Generated by <code>tldrx dashboard --static</code> from <code>${escapeHtml(data.root)}</code> `
      + `at ${escapeHtml(data.generatedAt)}. Self-contained: no external requests.`,
    "</footer>",
  ].join("\n");
}
