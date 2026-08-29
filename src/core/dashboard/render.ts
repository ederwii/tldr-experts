/**
 * The dashboard's markup — `DashboardModel` in, HTML out. Nothing else.
 *
 * Concept §12: read-only. It shows runs, the execution path, the handoffs, the
 * open questions, the plan, the experts and how to drive the loop from a
 * terminal — and it has no control that changes anything, because a dashboard
 * that can launch work is a second source of truth competing with the files.
 *
 * `[assumption]` **One source of truth for markup, on both sides of the wire.** The static
 * export renders on the server; the live page re-renders in the browser when the
 * watcher says a file changed. Those must never be two templates that drift, so
 * the `dash*` functions below are the ONLY markup in the product, and the live
 * page gets them by `Function.prototype.toString()` (`clientRenderer()`) — the
 * literal same function bodies, type annotations erased by the transpiler,
 * inlined into the page. That imposes one rule on every function in
 * `TEMPLATE_FUNCTIONS`:
 *
 *   **they must be closure-free** — no module constant, no import, nothing but
 *   their own arguments, their own locals and each other. A reference to
 *   anything outside the serialised set would resolve on the server and throw in
 *   the browser. `test/dashboard-render.test.ts` evaluates the serialised source
 *   and compares it byte-for-byte with the server render, so a violation fails
 *   loudly rather than showing up as a blank page.
 *
 * `[assumption]` That rule is why this file carries its own `dashEscape` rather
 * than importing `escapeHtml`: the core escaper closes over a module-level entity
 * table, and `src/core/markdown/` is not this wave's to change. The test asserts
 * the two agree character for character. The alternative considered — building a
 * browser bundle in `scripts/build.ts` — was rejected because `dist/` is
 * gitignored and running from source would then need a build step to render a
 * page.
 *
 * Self-contained means self-contained: CSS and JS are inlined, charts are inline
 * SVG, and the document contains no `http://` or `https://` reference at all, so
 * it renders identically offline and leaks nothing about who opened it.
 */
import { DASHBOARD_CSS } from "./styles.ts";
import { DASHBOARD_JS, liveScript } from "./script.ts";
import type {
  AreaModel, DashboardModel, ExpertModel, FaqEntryModel, PlanModel, QuestionModel, RunModel,
} from "./model.ts";

export const DASHBOARD_TITLE = "tldrx dashboard";
/** The element the client swaps on reload. The server fills it with the same markup. */
export const APP_ELEMENT_ID = "app";

/** One self-contained HTML document. `model.live` decides whether it watches. */
export function renderDashboard(model: DashboardModel): string {
  const scripts = [`<script>${DASHBOARD_JS}</script>`];
  if (model.live) {
    scripts.push(`<script>${clientRenderer()}</script>`,
      `<script>${liveScript(APP_ELEMENT_ID)}</script>`,);
  }
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${dashEscape(dashTitle(model))}</title>`,
    `<style>${DASHBOARD_CSS}</style>`,
    "</head>",
    "<body>",
    `<div id="${APP_ELEMENT_ID}">`,
    dashApp(model),
    "</div>",
    ...scripts,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** The browser tab's name. Serialised too, so the live page renames the tab. */
export function dashTitle(model: DashboardModel): string {
  return `tldrx dashboard — ${model.workspace}`;
}

/**
 * The serialised renderer, as plain JavaScript, for the live page.
 *
 * Order matters only for readability — these are function declarations, so they
 * hoist. `dashApp` is the entry point the page calls.
 */
export function clientRenderer(): string {
  return TEMPLATE_FUNCTIONS.map((fn) => fn.toString()).join("\n\n");
}

// ---------------------------------------------------------------------------
// Everything below is serialised to the browser. Closure-free, no imports.
// ---------------------------------------------------------------------------

/**
 * Escaping for a TEXT node: `&`, `<`, `>`.
 *
 * Quotes are only dangerous inside an attribute value, and a `<pre><code>` block
 * holding a shell command reads far better with real quotes in it — which is
 * what this page has always shown.
 */
export function dashText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escaping for an ATTRIBUTE value — the text set plus both quote characters. */
export function dashEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `$5.01`, or `$?` when the file never recorded a number. Matches `money()`. */
export function dashUsd(value: number | null): string {
  return value === null || value === undefined ? "$?" : `$${value.toFixed(2)}`;
}

export function dashPlural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

export function dashApp(model: DashboardModel): string {
  const sections: string[] = [];
  if (!model.workspaceFound) sections.push(dashNoWorkspace(model));
  sections.push(dashRunsSection(model));
  for (const run of model.runs) sections.push(dashRunDetail(run));
  sections.push(dashExpertsSection(model.experts, model.maxLevel));
  sections.push(dashFaqSection(model.faq));
  return [dashHeader(model), "<main>", ...sections, "</main>", dashFooter(model)].join("\n");
}

export function dashHeader(model: DashboardModel): string {
  const counts = `${dashPlural(model.runs.length, "run")} · ${dashPlural(model.experts.length, "expert")}`;
  const lead = model.live
    ? `Live and read-only · last read ${dashEscape(model.generatedAt)} · ${counts}. `
    : `Read-only snapshot generated ${dashEscape(model.generatedAt)} · ${counts}. `;
  const links: string[] = ['<a href="#runs">Runs</a>'];
  for (const run of model.runs) links.push(`<a href="#run-${dashEscape(run.id)}">${dashEscape(run.id)}</a>`);
  links.push('<a href="#experts">Experts</a>', '<a href="#faq">How to use</a>');
  return [
    '<header class="top">',
    `<h1>tldrx — ${dashEscape(model.workspace)}</h1>`,
    `<p>${lead}Nothing on this page changes anything.</p>`,
    '<nav class="top">',
    ...links,
    "</nav>",
    "</header>",
  ].join("\n");
}

export function dashNoWorkspace(model: DashboardModel): string {
  return [
    '<section id="no-workspace">',
    "<h2>No workspace here</h2>",
    `<p>There is no <code>.tldrx/</code> at <code>${dashEscape(model.root)}</code>, so there is `
      + "nothing to show yet. Two ways on:</p>",
    "<pre><code>tldrx init</code></pre>",
    "<pre><code>tldrx dashboard --root /path/to/your/workspace</code></pre>",
    '<p class="note">This page keeps watching — it will fill in by itself once the files exist.</p>',
    "</section>",
  ].join("\n");
}

export function dashRunsSection(model: DashboardModel): string {
  if (model.runs.length === 0) {
    return [
      '<section id="runs">',
      "<h2>Runs</h2>",
      '<p class="note">No runs yet. <code>tldrx run new --scope feature</code> opens one.</p>',
      "</section>",
    ].join("\n");
  }
  const cards: string[] = [];
  for (const run of model.runs) cards.push(dashRunCard(run));
  return [
    '<section id="runs">',
    "<h2>Runs</h2>",
    '<p><input id="run-filter" class="filter" type="text" placeholder="filter runs…" '
      + 'aria-label="Filter runs"></p>',
    ...cards,
    "</section>",
  ].join("\n");
}

export function dashRunCard(run: RunModel): string {
  const waiting: string[] = [];
  if (run.pendingGate !== null) {
    waiting.push(`<span class="pill wait">gate pending: ${dashEscape(run.pendingGate)}</span>`);
  }
  if (run.pendingQuestion !== null) {
    waiting.push(`<span class="pill wait">question open: ${dashEscape(run.pendingQuestion)}</span>`);
  }
  if (waiting.length === 0) waiting.push('<span class="pill ok">nothing pending</span>');

  return [
    `<div class="card" data-run-row="${dashEscape(run.filter)}">`,
    `<h3><a href="#run-${dashEscape(run.id)}">${dashEscape(run.id)}</a> — `
      + `${dashEscape(run.title === "" ? "(untitled)" : run.title)}</h3>`,
    `<p class="meta">scope <code>${dashEscape(run.scope === "" ? "?" : run.scope)}</code> · `
      + `status <strong>${dashEscape(run.status === "" ? "unknown" : run.status)}</strong> · `
      + `${dashEscape(dashUsd(run.spentUsd))} of ${dashEscape(dashUsd(run.ceilingUsd))}</p>`,
    `<div class="bar"><span style="width:${String(run.percent)}%"></span></div>`,
    `<p class="meta">${String(run.stagesDone)} of ${String(run.stagesTotal)} stages terminal `
      + `(${String(run.percent)}%)</p>`,
    `<p>${waiting.join(" ")}</p>`,
    "</div>",
  ].join("\n");
}

export function dashRunDetail(run: RunModel): string {
  const rows: string[] = [];
  for (const stage of run.path) {
    rows.push([
      "<tr>",
      `<td><code>${dashEscape(stage.phase)}</code></td>`,
      `<td><code>${dashEscape(stage.id)}</code></td>`,
      `<td>${dashEscape(stage.status)}</td>`,
      `<td>${dashEscape(stage.expert === null ? "—" : stage.expert)}</td>`,
      `<td>${dashEscape(stage.model === null ? "—" : stage.model)}</td>`,
      `<td>${dashEscape(dashUsd(stage.costUsd))} / ${dashEscape(dashUsd(stage.budgetUsd))}</td>`,
      `<td>${dashEscape(stage.gate === null ? "—" : stage.gate)}</td>`,
      "</tr>",
    ].join(""));
  }

  const sections: string[] = [
    `<section id="run-${dashEscape(run.id)}">`,
    `<h2>${dashEscape(run.id)} — ${dashEscape(run.title === "" ? "(untitled)" : run.title)}</h2>`,
    `<p class="meta">workflow <code>${dashEscape(run.workflow === "" ? "?" : run.workflow)}</code> · `
      + `repos ${dashEscape(run.repos.length === 0 ? "—" : run.repos.join(", "))} · `
      + `cursor <code>${dashEscape(run.cursor === null ? "no cursor recorded" : run.cursor)}</code> · `
      + `updated ${dashEscape(run.updatedAt === null ? "—" : run.updatedAt)}</p>`,
    "<h3>Execution path</h3>",
    '<div class="scroll"><table>',
    "<thead><tr><th>phase</th><th>stage</th><th>status</th><th>expert</th><th>model</th>"
      + "<th>cost / ceiling</th><th>gate</th></tr></thead>",
    `<tbody>${rows.join("")}</tbody>`,
    "</table></div>",
  ];

  if (run.plan !== null) sections.push(dashPlanBlock(run.plan));

  for (const phase of run.phases) {
    if (phase.handoffHtml === null && phase.questions.length === 0) continue;
    sections.push(`<h3>${dashEscape(phase.id)}</h3>`);
    if (phase.handoffHtml !== null) {
      sections.push(`<div class="card handoff">${phase.handoffHtml}</div>`);
    }
    for (const question of phase.questions) sections.push(dashQuestionCard(question));
  }

  sections.push("</section>");
  return sections.join("\n");
}

/** Stories and the waves that schedule them — shown only when the Plan wrote them. */
export function dashPlanBlock(plan: PlanModel): string {
  const parts: string[] = [`<h3>Plan (${dashEscape(plan.phase)})</h3>`];

  if (plan.waves.length > 0) {
    const waves: string[] = [];
    for (const wave of plan.waves) {
      waves.push(
        `<li><strong>${dashEscape(wave.id)}</strong> — `
          + `${wave.stories.length === 0 ? "no stories" : dashEscape(wave.stories.join(", "))}</li>`,
      );
    }
    parts.push(`<p class="meta">Waves run in order; a wave's stories run in parallel.</p><ul>${waves.join("")}</ul>`);
  }

  if (plan.stories.length > 0) {
    const rows: string[] = [];
    for (const story of plan.stories) {
      rows.push([
        "<tr>",
        `<td><code>${dashEscape(story.id)}</code></td>`,
        `<td>${dashEscape(story.title)}</td>`,
        `<td><code>${dashEscape(story.epic)}</code></td>`,
        `<td><code>${dashEscape(story.repo)}</code></td>`,
        `<td>${dashEscape(story.status)}</td>`,
        `<td>${dashEscape(story.wave === null ? "unscheduled" : story.wave)}</td>`,
        `<td>${dashEscape(story.dependsOn.length === 0 ? "—" : story.dependsOn.join(", "))}</td>`,
        "</tr>",
      ].join(""));
    }
    parts.push(
      '<div class="scroll"><table>'
        + "<thead><tr><th>story</th><th>title</th><th>epic</th><th>repo</th><th>status</th>"
        + "<th>wave</th><th>depends on</th></tr></thead>"
        + `<tbody>${rows.join("")}</tbody></table></div>`,
    );
  }

  if (plan.epics.length > 0) {
    const epics: string[] = [];
    for (const epic of plan.epics) {
      const count = epic.stories.length;
      epics.push(
        `<li><code>${dashEscape(epic.id)}</code> ${dashEscape(epic.title)} — `
          + `branch <code>${dashEscape(epic.branch)}</code>, ${dashEscape(epic.status)}, `
          + `${String(count)} ${count === 1 ? "story" : "stories"}</li>`,
      );
    }
    parts.push(`<h4>Epics</h4><ul>${epics.join("")}</ul>`);
  }

  if (plan.unreadable.length > 0) {
    parts.push(
      `<p class="pill bad">unreadable: ${dashEscape(plan.unreadable.join(", "))}</p>`,
    );
  }

  return parts.join("\n");
}

export function dashQuestionCard(question: QuestionModel): string {
  const lines: string[] = [
    '<div class="card">',
    `<h4>Open question ${dashEscape(question.id)}</h4>`,
    `<p><strong>${dashEscape(question.title)}</strong></p>`,
  ];
  if (question.whyAsked !== null) lines.push(`<p class="meta">${dashEscape(question.whyAsked)}</p>`);
  if (question.options.length > 0) {
    const options: string[] = [];
    for (const option of question.options) {
      options.push(`<li><strong>${dashEscape(option.letter)})</strong> ${dashEscape(option.text)}</li>`);
    }
    lines.push(`<ul>${options.join("")}</ul>`);
  }
  lines.push(`<pre><code>${dashText(question.answerCommand)}</code></pre>`, "</div>");
  return lines.join("\n");
}

export function dashExpertsSection(experts: readonly ExpertModel[], maxLevel: number): string {
  if (experts.length === 0) {
    return [
      '<section id="experts">',
      "<h2>Experts</h2>",
      '<p class="note">No experts yet. <code>tldrx init</code> seeds them; '
        + "<code>tldrx expert create &lt;name&gt;</code> adds one.</p>",
      "</section>",
    ].join("\n");
  }

  const cards: string[] = [];
  for (const expert of experts) {
    const lines: string[] = [
      '<div class="card">',
      `<h3>${dashEscape(expert.name)} <span class="pill">${dashEscape(expert.status)}</span></h3>`,
      `<p class="meta">last trained ${dashEscape(expert.lastTrained === null ? "never" : expert.lastTrained)} · `
        + `${dashPlural(expert.areas.length, "area")} · levels computed from evidence (spec §2.6)</p>`,
    ];
    if (expert.error !== null) lines.push(`<p class="pill bad">unreadable: ${dashEscape(expert.error)}</p>`);
    lines.push(dashStarChart(expert.areas, maxLevel));
    for (const warning of expert.warnings) lines.push(`<p class="pill wait">${dashEscape(warning)}</p>`);
    if (expert.areas.length > 0) {
      const prompts: string[] = [];
      for (const area of expert.areas) {
        prompts.push(`<pre><code>${dashText(area.trainPrompt)} --print-prompt</code></pre>`);
      }
      lines.push(`<h4>Train me on…</h4>${prompts.join("")}`);
    }
    lines.push("</div>");
    cards.push(lines.join("\n"));
  }

  return ['<section id="experts">', "<h2>Experts</h2>", ...cards, "</section>"].join("\n");
}

/**
 * The star chart as inline SVG — the same numbers `expert list` prints, drawn.
 *
 * Inline and geometric on purpose: no icon font, no sprite sheet, no external
 * request. Coordinates are rounded to two decimals so the same competencies.yml
 * always produces byte-identical markup. No `xmlns`: this is inline SVG in an
 * HTML document, and the page must contain no URL of any kind, namespace
 * identifiers included.
 */
export function dashStarChart(areas: readonly AreaModel[], maxLevel: number): string {
  if (areas.length === 0) {
    return '<p class="note">No areas yet — training is what gives an expert evidence.</p>';
  }
  const starR = 8;
  const step = 22;
  const rowH = 26;
  const labelW = 150;
  const width = labelW + step * maxLevel + 120;
  const height = rowH * areas.length + 8;
  const parts: string[] = [
    `<svg viewBox="0 0 ${String(width)} ${String(height)}" width="100%" height="${String(height)}" role="img" `
      + `aria-label="Competency star chart">`,
  ];

  areas.forEach((area, row) => {
    const y = row * rowH + rowH / 2;
    parts.push(
      `<text x="0" y="${String(Math.round((y + 4) * 100) / 100)}" font-size="12" `
        + `font-family="ui-monospace, Menlo, Consolas, monospace" `
        + `fill="currentColor">${dashEscape(area.id)}</text>`,
    );
    for (let i = 0; i < maxLevel; i++) {
      const cx = labelW + i * step + starR;
      const filled = i < area.level;
      parts.push(
        `<polygon points="${dashStarPoints(cx, y, starR)}" fill="${filled ? "currentColor" : "none"}" `
          + `stroke="currentColor" stroke-width="1" opacity="${filled ? "1" : "0.35"}" />`,
      );
    }
    parts.push(
      `<text x="${String(labelW + step * maxLevel + 8)}" y="${String(Math.round((y + 4) * 100) / 100)}" `
        + `font-size="12" fill="currentColor" opacity="0.75">${String(area.level)}/${String(maxLevel)} · `
        + `${String(area.evidenceCount)} evidence</text>`,
    );
  });

  parts.push("</svg>");
  return parts.join("");
}

export function dashStarPoints(cx: number, cy: number, radius: number): string {
  const points: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? radius : radius * 0.4;
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    points.push(
      `${String(Math.round((cx + r * Math.cos(angle)) * 100) / 100)},`
        + `${String(Math.round((cy + r * Math.sin(angle)) * 100) / 100)}`,
    );
  }
  return points.join(" ");
}

export function dashFaqSection(faq: readonly FaqEntryModel[]): string {
  const parts: string[] = [
    '<section id="faq">',
    "<h2>How to use this</h2>",
    "<p>The files are the product; this page is a window onto them. Everything below is run "
      + "in a terminal at the workspace root.</p>",
  ];
  for (const entry of faq) {
    parts.push(`<h4>${dashEscape(entry.heading)}</h4>`);
    parts.push(`<pre><code>${dashText(entry.commands.join("\n"))}</code></pre>`);
  }
  parts.push(
    '<p class="note">Why is nothing clickable? Because the run is the files. A button here '
      + "would be a second way to change state, and then neither would be the truth.</p>",
    "</section>",
  );
  return parts.join("\n");
}

export function dashFooter(model: DashboardModel): string {
  const how = model.live
    ? `Served read-only by <code>tldrx dashboard</code> from <code>${dashEscape(model.root)}</code>, `
      + `re-read at ${dashEscape(model.generatedAt)}. Watching for file changes; writing nothing.`
    : `Generated by <code>tldrx dashboard --static</code> from <code>${dashEscape(model.root)}</code> `
      + `at ${dashEscape(model.generatedAt)}. Self-contained: no external requests.`;
  return ["<footer>", how, "</footer>"].join("\n");
}

/**
 * Every function the live page needs, in one list.
 *
 * Adding a template function without adding it here is the one way to break the
 * live page; `test/dashboard-render.test.ts` catches it by evaluating this list
 * in isolation and comparing to the server render.
 */
const TEMPLATE_FUNCTIONS = [
  dashText,
  dashEscape,
  dashTitle,
  dashUsd,
  dashPlural,
  dashStarPoints,
  dashStarChart,
  dashQuestionCard,
  dashPlanBlock,
  dashRunCard,
  dashRunDetail,
  dashRunsSection,
  dashExpertsSection,
  dashFaqSection,
  dashNoWorkspace,
  dashHeader,
  dashFooter,
  dashApp,
] as const;
