/**
 * The dashboard's markup — `DashboardModel` in, HTML out. Nothing else.
 *
 * Concept §12: read-only. It shows runs, the execution path, the handoffs, the
 * open questions, the plan, the experts and how to drive the loop from a
 * terminal — and it has no control that changes anything, because a dashboard
 * that can launch work is a second source of truth competing with the files.
 * The only controls on the page are copy-to-clipboard and a status filter, and
 * neither leaves the browser.
 *
 * `[assumption]` **One renderer, and it runs in the browser.** The page ships the
 * model as JSON in a `<script type="application/json">` and draws it client-side
 * — the shape `docs/dashboard-model.md` promises, and what the design brief asks
 * for. That is also why the `dash*` functions below stay **closure-free**: no
 * module constant, no import, nothing but their own arguments, their own locals
 * and each other. They reach the browser through `Function.prototype.toString()`
 * (`clientRenderer()`), type annotations erased by the transpiler, so a reference
 * to anything outside the serialised set would resolve here and throw there.
 * `test/dashboard-render.test.ts` evaluates the serialised source in an empty
 * scope and renders a fixture through it, so a violation fails loudly rather
 * than showing up as a blank page.
 *
 * Keeping them here rather than as a string in `script.ts` is what keeps `tsc
 * --noEmit --strict` on the renderer: rename a field in `DashboardModel` and the
 * build breaks, instead of a panel silently going blank.
 *
 * `[assumption]` That rule is why this file carries its own `dashEscape` rather
 * than importing `escapeHtml`: the core escaper closes over a module-level entity
 * table. The test asserts the two agree character for character.
 *
 * Self-contained means self-contained: CSS and JS are inlined, charts are inline
 * SVG, and the document contains no `http://` or `https://` reference at all, so
 * it renders identically offline and leaks nothing about who opened it.
 */
import { DASHBOARD_CSS } from "./styles.ts";
import { DASHBOARD_JS, liveScript } from "./script.ts";
import type {
  DashboardModel, ExpertModel, PhaseModel, QuestionModel, RunModel,
} from "./model.ts";

export const DASHBOARD_TITLE = "tldrx dashboard";
/** The element the client draws into. The server ships it empty. */
export const APP_ELEMENT_ID = "main";
/** Where the model rides to the browser. Read once at boot, replaced on reload. */
export const MODEL_ELEMENT_ID = "model-data";

/** The view state the chrome and the runs list read. Nothing here touches disk. */
export interface DashUi {
  readonly status: string;
  readonly sort: string;
}

/** Which view the hash asks for. `id` is set only for a run detail. */
export interface DashRoute {
  readonly view: string;
  readonly id: string | null;
}

/** The one thing a run is waiting on, when it is waiting on a human. */
export interface DashPending {
  readonly kind: string;
  readonly text: string;
}

/**
 * One self-contained HTML document: the shell, the model, the renderer.
 *
 * The body ships empty on purpose — `DASHBOARD_JS` draws it from the embedded
 * model at boot. `model.live` decides only whether it also watches for changes.
 */
export function renderDashboard(model: DashboardModel): string {
  const scripts = [
    `<script type="application/json" id="${MODEL_ELEMENT_ID}">${dashModelJson(model)}</script>`,
    `<script>${clientRenderer()}</script>`,
    `<script>${DASHBOARD_JS}</script>`,
  ];
  if (model.live) scripts.push(`<script>${liveScript()}</script>`);
  return [
    "<!doctype html>",
    '<html lang="en" data-theme="auto">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${dashEscape(dashTitle(model))}</title>`,
    `<style>${DASHBOARD_CSS}</style>`,
    "</head>",
    "<body>",
    `<a class="sr-only" href="#${APP_ELEMENT_ID}">Skip to content</a>`,
    '<header class="topbar">',
    '<div class="topbar__in">',
    '<div class="brand"><span class="brand__mark">tldrx</span>'
      + `<span class="brand__ws" id="ws">${dashText(model.workspace)}</span></div>`,
    '<div class="topbar__meta" id="topmeta"></div>',
    "</div>",
    '<nav class="nav" id="nav" aria-label="Views"></nav>',
    "</header>",
    `<main id="${APP_ELEMENT_ID}" class="shell" tabindex="-1"></main>`,
    '<div class="sr-only" role="status" aria-live="polite" id="live-region"></div>',
    ...scripts,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * The model, safe to sit inside a `<script>` element.
 *
 * `handoffHtml` is real HTML, so a handoff quoting `</script>` would otherwise
 * close the element and spill markup into the document. Escaping every `<` as
 * `<` is still valid JSON, `JSON.parse` gives the original string back, and
 * no byte sequence in the payload can end the element early.
 */
export function dashModelJson(model: DashboardModel): string {
  return JSON.stringify(model).replace(/</g, "\\u003c");
}

/** The browser tab's name. Serialised too, so the live page renames the tab. */
export function dashTitle(model: DashboardModel): string {
  return `tldrx dashboard — ${model.workspace}`;
}

/**
 * The serialised renderer, as plain JavaScript, for the page.
 *
 * Order matters only for readability — these are function declarations, so they
 * hoist. `dashMain` is the entry point the page calls for the body, with
 * `dashTopMeta` and `dashNav` for the chrome.
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
 * Quotes are only dangerous inside an attribute value, and a `<code>` block
 * holding a shell command reads far better with real quotes in it — which is
 * what the copy rows show.
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

/** `run.yml` writes `awaiting_gate`; a reader wants "awaiting gate". */
export function dashWords(text: string | null): string {
  return text === null || text === undefined ? "" : text.replace(/_/g, " ");
}

/** `2026-08-29 04:54` in the reader's own timezone, or an em dash. */
export function dashDateTime(iso: string | null): string {
  if (iso === null || iso === "") return "—";
  const when = new Date(iso);
  if (isNaN(when.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(when.getFullYear())}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} `
    + `${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

/**
 * "12m ago". `nowMs` is an argument rather than a `Date.now()` call so the
 * function stays pure — the same model and the same clock render the same page.
 */
export function dashAgo(iso: string | null, nowMs: number): string {
  if (iso === null || iso === "") return "";
  const seconds = (nowMs - new Date(iso).getTime()) / 1000;
  if (isNaN(seconds)) return "";
  if (seconds < 90) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${String(Math.round(minutes))}m ago`;
  const hours = minutes / 60;
  if (hours < 48) return `${String(Math.round(hours))}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
}

/**
 * One status vocabulary for the whole page.
 *
 * `run.yml`, stages, stories, epics and experts each spell status their own way.
 * Every one of them lands in one of five tones, so a colour means the same thing
 * wherever the reader sees it.
 */
export function dashTone(status: string | null): string {
  const text = String(status === null || status === undefined ? "" : status).toLowerCase();
  if (/awaiting|blocked|failed|error|reject/.test(text)) return "wait";
  if (/done|approved|complete|passed|verified/.test(text)) return "done";
  if (/ready|running|active|in_progress|working/.test(text)) return "active";
  if (/skipped|cancelled|canceled|draft/.test(text)) return "off";
  return "idle";
}

/** A status chip. `label` overrides the words; `plain` drops the leading dot. */
export function dashChip(status: string | null, label: string | null, plain: boolean): string {
  const words = label === null ? dashWords(status) : label;
  return `<span class="chip${plain ? " chip--plain" : ""}" data-st="${dashEscape(dashTone(status))}">`
    + `${dashText(words)}</span>`;
}

/**
 * A copy-paste terminal command.
 *
 * The command is text, never a link and never a button that runs it — the
 * dashboard has no write path. The only button copies the string to the
 * clipboard, which never leaves the browser.
 */
export function dashCmd(text: string, id: string): string {
  return `<div class="cmd"><code id="${dashEscape(id)}">${dashText(text)}</code>`
    + `<button type="button" data-copy="${dashEscape(text)}" `
    + 'aria-label="Copy command to clipboard">copy</button></div>';
}

/**
 * The one thing a run waits on, when it waits on a HUMAN — or null.
 *
 * Read straight off `run.waiting`, which is `tldrx run status`'s own answer
 * (`src/core/run/waiting.ts`). Three kinds raise a card: a gate to sign, a
 * question to answer, a stage that failed. `ready` and `done` are states of the
 * work, not asks, and a page that alerts on them alerts on everything.
 *
 * A run waiting behind a sibling raises nothing either, whatever its own stage
 * says — the same call `tldrx status` makes when it prints no command for a
 * blocked run. Its gate is real, but signing it is not the next move, and an
 * alert that cannot be acted on is the noise that makes the others ignorable.
 */
export function dashPending(run: RunModel): DashPending | null {
  if (run.blockedBy.length > 0) return null;
  const kind = run.waiting.kind;
  if (kind === "gate") {
    return { kind: "gate", text: `stage ${run.pendingGate ?? "?"} is waiting at a gate` };
  }
  if (kind === "answer") {
    return { kind: "question", text: run.pendingQuestion ?? run.waiting.message };
  }
  if (kind === "failed") return { kind: "failed", text: run.waiting.message };
  return null;
}

/** `260903-alpha` → `alpha`. Dependencies were proposed as slugs; say slugs. */
export function dashSlug(id: string): string {
  const match = /^\d{6}-(.+)$/.exec(String(id));
  return match === null ? String(id) : String(match[1]);
}

/**
 * The WAITING ON column: what this run needs, in the fewest words that are true.
 *
 * Every kind gets a line, not only the three that raise a card — "nothing" in a
 * column headed "waiting on" is what made a `ready` run look finished. A blocked
 * run says what it is behind first, whatever its own stage says: a gate you
 * cannot reach yet is not the thing to go and sign.
 */
export function dashWaitingCell(run: RunModel): string {
  if (run.blockedBy.length > 0) {
    return `<span class="nowrap">blocked by ${dashText(run.blockedBy.map(dashSlug).join(", "))}</span>`;
  }
  const pending = dashPending(run);
  if (pending !== null) return dashText(pending.text);
  if (run.waiting.kind === "ready") {
    return `<span class="nowrap">ready — <code>tldrx next ${dashText(run.id)}</code></span>`;
  }
  return `<span class="faint">nothing — ${dashText(dashWords(run.status))}</span>`;
}

/** The first run in workspace order that a human could actually move, or "". */
export function dashNextRun(model: DashboardModel): string {
  for (const id of model.order) {
    const run = model.runs.filter((candidate) => candidate.id === id)[0];
    if (run !== undefined && run.runnable) return run.id;
  }
  return "";
}

/**
 * The three counts `tldrx status` opens with, for runs: how many you could
 * start, how many are waiting behind a sibling, how many are waiting on YOU.
 *
 * Disjoint by precedence — blocked, then waiting-on-you, then ready — so the
 * numbers add up to the run count and nobody has to work out an overlap. Every
 * one is read off the model; nothing here re-derives a state.
 */
export function dashAttention(model: DashboardModel): string {
  let blocked = 0;
  let human = 0;
  let ready = 0;
  let first = "";
  for (const id of model.order) {
    const run = model.runs.filter((candidate) => candidate.id === id)[0];
    if (run === undefined) continue;
    if (run.blockedBy.length > 0) { blocked++; continue; }
    if (dashPending(run) !== null) { human++; continue; }
    if (run.waiting.kind === "ready" && run.runnable) {
      ready++;
      if (first === "") first = run.id;
    }
  }
  if (model.runs.length === 0) return "";
  const command = first === ""
    ? ""
    : ` <code class="attn__cmd">tldrx next ${dashText(first)}</code>`;
  return '<div class="attn"><span class="attn__n" data-st="'
    + `${ready > 0 ? "active" : "idle"}">${dashText(dashPlural(ready, "run"))} ready</span>${command}`
    + `<span class="attn__sep">·</span><span class="attn__n" data-st="idle">${String(blocked)} blocked</span>`
    + `<span class="attn__sep">·</span><span class="attn__n" data-st="${human > 0 ? "wait" : "idle"}">`
    + `${String(human)} waiting on you</span></div>`;
}

/**
 * The dependency chains, as text: `alpha → bravo → charlie`.
 *
 * Every arrow is a real `depends_on` edge (`src/core/run/dependencies.ts`), so a
 * fork prints one line per branch rather than one flattened list implying an
 * order nobody asked for. A finished run is ticked; the one a human could pick
 * up now is highlighted. Nothing is drawn when no run depends on another.
 */
export function dashChains(model: DashboardModel): string {
  if (model.chains.length === 0) return "";
  const next = dashNextRun(model);
  const lines = model.chains.map((chain) => {
    const links = chain.map((id) => {
      const run = model.runs.filter((candidate) => candidate.id === id)[0];
      const done = run !== undefined && run.status === "done";
      const tone = done ? "done" : id === next ? "active" : "idle";
      const tick = done ? "&#10003; " : "";
      return `<a class="chain__link" data-st="${dashEscape(tone)}" `
        + `href="#/run/${dashEscape(encodeURIComponent(id))}">${tick}${dashText(dashSlug(id))}</a>`;
    });
    return `<div class="chain">${links.join('<span class="chain__arrow">&rarr;</span>')}</div>`;
  });
  return '<div class="section" style="margin-top:0"><div class="section__title">'
    + "<h2>Dependency chain</h2>"
    + '<span class="eyebrow">run.yml triage.depends_on</span></div>'
    + `<div class="card">${lines.join("")}</div></div>`;
}

/** `#/run/260829-x` → the run detail; anything unknown → the runs list. */
export function dashRoute(hash: string): DashRoute {
  const parts = String(hash === "" ? "#/runs" : hash).replace(/^#\/?/, "").split("/");
  if (parts[0] === "run" && parts[1] !== undefined && parts[1] !== "") {
    return { view: "run", id: decodeURIComponent(parts[1]) };
  }
  const known = ["runs", "experts", "watchers", "faq"];
  return { view: known.indexOf(parts[0] ?? "") >= 0 ? String(parts[0]) : "runs", id: null };
}

/** How many runs are waiting on a human. The only number the nav badges. */
export function dashWaiting(model: DashboardModel): number {
  return model.runs.filter((run) => dashPending(run) !== null).length;
}

/** Live or static, when it was read, which model version drew it. */
export function dashTopMeta(model: DashboardModel): string {
  return `<span class="live${model.live ? "" : " live--off"}"><span class="live__dot"></span>`
    + `${model.live ? "live" : "static export"}</span>`
    + `<span>read ${dashText(dashDateTime(model.generatedAt))}</span>`
    + `<span class="faint">model v${String(model.modelVersion)}</span>`;
}

/** The view tabs. The runs tab carries the count of runs waiting on a human. */
export function dashNav(model: DashboardModel, view: string): string {
  const views = [
    { id: "runs", label: "Runs" },
    { id: "experts", label: "Experts" },
    { id: "watchers", label: "Watchers" },
    { id: "faq", label: "How to use" },
  ];
  const waiting = dashWaiting(model);
  const active = view === "run" ? "runs" : view;
  return views.map((entry) => {
    const badge = entry.id === "runs" && waiting > 0
      ? `<span class="tab__count" title="runs waiting on a human">${String(waiting)}</span>`
      : "";
    return `<a class="tab" href="#/${entry.id}"${entry.id === active ? ' aria-current="page"' : ""}>`
      + `${entry.label}${badge}</a>`;
  }).join("");
}

/** The body, for whichever view the hash asked for. The entry point. */
export function dashMain(
  model: DashboardModel,
  ui: DashUi,
  route: DashRoute,
  nowMs: number,
): string {
  if (!model.workspaceFound) return dashNoWorkspace(model);
  if (route.view === "run") return dashRunView(model, route.id ?? "", nowMs);
  if (route.view === "experts") return dashExpertsView(model);
  if (route.view === "watchers") return dashWatchersView(model);
  if (route.view === "faq") return dashFaqView(model);
  return dashRunsView(model, ui, nowMs);
}

export function dashNoWorkspace(model: DashboardModel): string {
  return '<div class="viewhead"><h1>No workspace here</h1>'
    + `<p>There is no <code>.tldrx/</code> at <code>${dashText(model.root)}</code>, so there is `
    + "nothing to report yet. Two ways on:</p></div>"
    + `<div class="stack">${dashCmd("tldrx init", "nw-init")}`
    + `${dashCmd("tldrx dashboard --root /path/to/your/workspace", "nw-root")}</div>`
    + '<p class="muted" style="margin-top:var(--space-md)">This page keeps watching — it fills in '
    + "by itself once the files exist.</p>";
}

// ---------------------------------------------------------------------------
// View: runs
// ---------------------------------------------------------------------------

export function dashRunsView(model: DashboardModel, ui: DashUi, nowMs: number): string {
  const statuses: string[] = [];
  for (const run of model.runs) if (statuses.indexOf(run.status) < 0) statuses.push(run.status);

  // `order` is the workspace's own answer to "what should I do next" —
  // topological on depends_on, runnable first — so it is the default. The other
  // two remain: `updated` for "what moved", `id` for a stable list.
  const rank = (run: RunModel): number => {
    const at = model.order.indexOf(run.id);
    return at < 0 ? model.order.length : at;
  };
  const rows = model.runs
    .filter((run) => ui.status === "all" || run.status === ui.status)
    .slice()
    .sort((a, b) => (ui.sort === "updated"
      ? String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))
      : ui.sort === "id"
        ? b.id.localeCompare(a.id)
        : rank(a) - rank(b)));
  const waiting = model.runs.filter((run) => dashPending(run) !== null);
  const next = dashNextRun(model);

  const parts: string[] = [
    '<div class="viewhead"><h1>Runs</h1><p>Every fact here was read from files on disk at '
      + `${dashText(dashDateTime(model.generatedAt))}. Nothing on this page can change them.</p></div>`,
    dashAttention(model),
  ];

  if (waiting.length > 0) {
    const alerts = waiting.map((run) => {
      const pending = dashPending(run);
      const kind = pending === null ? "" : pending.kind;
      const text = pending === null ? "" : pending.text;
      return `<div class="alert"><span class="alert__kind">${dashText(kind)}</span>`
        + `<span><a href="#/run/${dashEscape(encodeURIComponent(run.id))}">`
        + `${dashText(run.title === "" ? run.id : run.title)}</a> — ${dashText(text)}`
        + '<br><span class="faint mono" style="font-size:var(--text-2xs)">waiting on a human</span>'
        + "</span></div>";
    });
    parts.push(`<div class="stack stack--sm" style="margin-bottom:var(--space-lg)">${alerts.join("")}</div>`);
  }

  const statusButtons = ["all"].concat(statuses).map((status) =>
    `<button class="fbtn" type="button" data-filter="${dashEscape(status)}" `
    + `aria-pressed="${ui.status === status ? "true" : "false"}">${dashText(dashWords(status))}</button>`);
  const sortButtons = [["order", "order"], ["updated", "updated"], ["id", "run id"]].map((pair) =>
    `<button class="fbtn" type="button" data-sort="${dashEscape(pair[0] ?? "")}" `
    + `aria-pressed="${ui.sort === pair[0] ? "true" : "false"}">${dashText(pair[1] ?? "")}</button>`);
  parts.push(
    '<div class="filters"><span class="filters__label">status</span>'
      + statusButtons.join("")
      + '<span class="filters__label" style="margin-left:var(--space-md)">sort</span>'
      + sortButtons.join("")
      + "</div>",
  );
  parts.push(dashChains(model));

  const list: string[] = [
    '<div class="card card--flush"><div class="runhead">'
      + "<span>run</span><span>status</span><span>phase progress</span><span>spend</span>"
      + "<span>waiting on</span></div>",
  ];
  if (rows.length === 0) {
    list.push(`<div class="empty" style="border:0">No runs with status <strong>${
      dashText(dashWords(ui.status))}</strong>.</div>`);
  }
  for (const run of rows) list.push(dashRunRow(run, nowMs, run.id === next));
  list.push("</div>");
  parts.push(list.join(""));
  return parts.join("");
}

/**
 * One row of the runs list: who, where, how far, how much, what it waits on.
 *
 * `isNext` marks the one run a human could pick up right now — the same
 * `← next` marker `tldrx status` prints, so the two agree about where to start.
 */
export function dashRunRow(run: RunModel, nowMs: number, isNext: boolean): string {
  const pending = dashPending(run);
  const repos = run.repos.length === 0
    ? ""
    : ` · ${dashPlural(run.repos.length, "repo")}`;
  const cursor = run.cursor === null ? "" : ` · at ${run.cursor}`;
  const pips = run.path
    .map((stage) => `<span class="pip" data-st="${dashEscape(dashTone(stage.status))}"></span>`)
    .join("");

  return `<a class="runrow" href="#/run/${dashEscape(encodeURIComponent(run.id))}">`
    + `<div><div class="runrow__id">${dashText(run.id)}`
    + (isNext ? '<span class="runrow__next">&larr; next</span>' : "")
    + "</div>"
    + `<div class="runrow__title">${dashText(run.title === "" ? "(untitled)" : run.title)}</div>`
    + `<div class="runrow__sub">${dashText((run.scope === "" ? "—" : run.scope) + repos + cursor)}</div></div>`
    + `<div class="runrow__cell">${dashChip(run.status, null, false)}`
    + `<span class="runrow__k">${dashText(dashAgo(run.updatedAt, nowMs))}</span></div>`
    + '<div class="runrow__cell"><div class="pips" role="img" aria-label="'
    + `${String(run.stagesDone)} of ${String(run.stagesTotal)} stages done">${pips}</div>`
    + `<span class="runrow__v">${String(run.stagesDone)}/${String(run.stagesTotal)} stages · `
    + `${String(run.percent)}%</span></div>`
    + `<div class="runrow__cell"><span class="runrow__v">${dashText(dashUsd(run.spentUsd))} `
    + `<span class="faint">/ ${dashText(dashUsd(run.ceilingUsd))}</span></span>`
    + `${dashMeter(run.spentUsd, run.ceilingUsd)}</div>`
    + `<div class="runrow__wait"${pending === null ? "" : ' data-wait="1"'}>`
    + dashWaitingCell(run)
    + "</div></a>";
}

/** Spend against ceiling. Turns loud at 90%, which is where a human should look. */
export function dashMeter(spent: number | null, ceiling: number | null): string {
  if (spent === null || ceiling === null || ceiling === 0) return "";
  const percent = Math.min(100, Math.round((spent / ceiling) * 100));
  return `<div class="meter" title="${String(percent)}% of ceiling">`
    + `<div class="meter__fill" data-over="${percent >= 90 ? "1" : "0"}" `
    + `style="width:${String(percent)}%"></div></div>`;
}

// ---------------------------------------------------------------------------
// View: one run
// ---------------------------------------------------------------------------

export function dashRunView(model: DashboardModel, id: string, nowMs: number): string {
  const run = model.runs.filter((candidate) => candidate.id === id)[0];
  if (run === undefined) {
    return '<div class="viewhead"><h1>Run not found</h1><p><code>'
      + `${dashText(id)}</code> is not in this model. <a href="#/runs">Back to runs</a></p></div>`;
  }
  const pending = dashPending(run);
  const parts: string[] = [
    '<a class="backlink" href="#/runs">&larr; all runs</a>'
      + `<div class="viewhead"><div class="eyebrow">${dashText(run.id)}</div>`
      + `<h1>${dashText(run.title === "" ? "(untitled)" : run.title)}</h1></div>`,
  ];

  if (pending !== null) {
    parts.push('<div class="alert" style="margin-bottom:var(--space-lg)">'
      + `<span class="alert__kind">${dashText(pending.kind)}</span><span>${dashText(pending.text)}`
      + (pending.kind === "gate" ? " — a human approves or rejects it in the terminal." : "")
      + "</span></div>");
  }

  const workflow = run.workflow !== "" && run.workflow !== run.scope
    ? ` <span class="faint">/ ${dashText(run.workflow)}</span>`
    : "";
  const repos = run.repos.length === 0
    ? ""
    : '<div style="margin-top:var(--space-lg)"><div class="kv__k">repos</div>'
      + `<div class="row" style="margin-top:6px">${run.repos
        .map((repo) => `<span class="tag">${dashText(repo)}</span>`).join("")}</div></div>`;
  parts.push('<div class="card"><div class="kv">'
    + dashKv("status", dashChip(run.status, null, false))
    + dashKv("scope", dashText(run.scope === "" ? "—" : run.scope) + workflow)
    + dashKv("cursor", '<span class="mono" style="font-size:var(--text-xs)">'
      + `${dashText(run.cursor === null ? "—" : run.cursor)}</span>`)
    + dashKv("spent", `<span class="num">${dashText(dashUsd(run.spentUsd))}</span> `
      + `<span class="faint">of ${dashText(dashUsd(run.ceilingUsd))}</span>`
      + dashMeter(run.spentUsd, run.ceilingUsd))
    + dashKv("stages", `<span class="num">${String(run.stagesDone)}/${String(run.stagesTotal)}</span> `
      + `<span class="faint">${String(run.percent)}%</span>`)
    + dashKv("updated", `<span class="nowrap">${dashText(dashDateTime(run.updatedAt))}</span> `
      + `<span class="faint nowrap">${dashText(dashAgo(run.updatedAt, nowMs))}</span>`)
    + `</div>${repos}</div>`);

  parts.push(dashPathSection(run));

  const pairs: { phase: PhaseModel; question: QuestionModel }[] = [];
  for (const phase of run.phases) {
    for (const question of phase.questions) pairs.push({ phase, question });
  }
  if (pairs.length > 0) {
    parts.push('<div class="section"><div class="section__title"><h2>Open questions</h2>'
      + `<span class="eyebrow">${String(pairs.length)} waiting</span></div><div class="stack">`
      + pairs.map((pair) => dashQuestion(run, pair.phase, pair.question)).join("")
      + "</div></div>");
  }

  parts.push(dashHandoffsSection(run));
  parts.push(dashPlanSection(run));
  return parts.join("");
}

export function dashKv(key: string, value: string): string {
  return `<div><div class="kv__k">${dashText(key)}</div><div class="kv__v">${value}</div></div>`;
}

/** Phase → stage → expert → model → cost → gate, in `run.yml` order. */
export function dashPathSection(run: RunModel): string {
  const rows = run.path.map((stage) => {
    // Only the stage the run is actually stopped at is waiting on a human. Every
    // gate downstream of it also reads `pending`, and marking those too would
    // paint most of the table as an alert and mean nothing.
    const waits = run.pendingGate === stage.id;
    return `<tr${waits ? ' data-wait="1"' : ""}>`
      + `<td class="mono faint" style="font-size:var(--text-2xs)">${dashText(stage.phase)}</td>`
      + `<td class="mono">${dashText(stage.id)}</td>`
      + `<td>${dashChip(stage.status, null, false)}</td>`
      + `<td>${dashText(stage.expert === null ? "—" : stage.expert)}</td>`
      + `<td><span class="tag">${dashText(stage.model === null ? "—" : stage.model)}</span></td>`
      + `<td class="num" style="white-space:nowrap">${dashText(dashUsd(stage.costUsd))}`
      + (stage.budgetUsd === null ? "" : ` <span class="faint">/ ${dashText(dashUsd(stage.budgetUsd))}</span>`)
      + "</td>"
      + `<td>${stage.gate === null
        ? '<span class="faint">none</span>'
        : dashChip(stage.gate, stage.gate, false)}</td></tr>`;
  }).join("");

  return '<div class="section"><div class="section__title"><h2>Execution path</h2>'
    + '<span class="eyebrow">run.yml order</span></div>'
    + '<div class="card card--flush"><div class="scroll-x"><table><thead><tr>'
    + "<th>phase</th><th>stage</th><th>status</th><th>expert</th><th>model</th><th>cost</th>"
    + `<th>gate</th></tr></thead><tbody>${rows}</tbody></table></div></div></div>`;
}

/**
 * The handoffs, each in a panel that remembers whether it was open.
 *
 * `handoffHtml` is the model's one HTML field (`docs/dashboard-model.md`): style
 * it, do not re-parse it, and do not escape it. The panel id is derived from the
 * run and the phase so a re-render finds the same panel and leaves it open.
 */
export function dashHandoffsSection(run: RunModel): string {
  const panels = run.phases.map((phase) => {
    if (phase.handoffHtml === null) {
      return `<div class="empty"><strong>${dashText(phase.id)}</strong> · `
        + `${dashText(dashWords(phase.status))} — no handoff written yet.</div>`;
    }
    return `<details class="panel" id="${dashEscape(dashPanelId(run, phase))}">`
      + '<summary><span class="caret">&#9656;</span>'
      + `<h3>${dashText(phase.id)}</h3>${dashChip(phase.status, null, false)}`
      + '<span class="eyebrow" style="margin-left:auto">handoff</span></summary>'
      + `<div class="panel__body"><div class="prose" data-prose="1">${phase.handoffHtml}</div>`
      + "</div></details>";
  }).join("");

  return '<div class="section"><div class="section__title"><h2>Handoffs</h2>'
    + '<span class="eyebrow">evidence behind each stage</span></div>'
    + `<div class="stack">${panels}</div></div>`;
}

/** Stable across re-renders, which is what keeps an open panel open. */
export function dashPanelId(run: RunModel, phase: PhaseModel): string {
  return `ho-${run.id}-${phase.id}`;
}

export function dashQuestion(run: RunModel, phase: PhaseModel, question: QuestionModel): string {
  const why = question.whyAsked === null
    ? ""
    : `<p class="muted" style="font-size:var(--text-sm)">${dashText(question.whyAsked)}</p>`;
  const options = question.options.length === 0
    ? ""
    : `<div class="stack stack--sm">${question.options.map((option) =>
      `<div class="opt"><span class="opt__letter">${dashText(option.letter)}</span>`
      + `<span>${dashText(option.text)}</span></div>`).join("")}</div>`;
  return `<div class="q"><div class="q__head"><span class="q__id">${dashText(question.id)}</span>`
    + `<span class="q__title">${dashText(question.title)}</span>`
    + `<span class="eyebrow" style="margin-left:auto">${dashText(phase.id)}</span></div>`
    + `<div class="q__body">${why}${options}`
    + '<div><div class="kv__k" style="margin-bottom:4px">answer it in the terminal</div>'
    + `${dashCmd(question.answerCommand, `ac-${run.id}-${question.id}`)}</div></div></div>`;
}

/** Epics, their stories and the waves that schedule them. */
export function dashPlanSection(run: RunModel): string {
  const plan = run.plan;
  if (plan === null) {
    return '<div class="section"><div class="section__title"><h2>Plan &amp; build</h2>'
      + '<span class="eyebrow">plan · null</span></div>'
      + '<div class="empty">The Plan phase has not written stories yet. When it does, epics, '
      + "stories and waves appear here, and each story shows its status, repo and dependencies."
      + "</div></div>";
  }

  const byId: Record<string, { title: string; repo: string; status: string; wave: string | null;
    dependsOn: readonly string[] }> = {};
  for (const story of plan.stories) {
    byId[story.id] = {
      title: story.title, repo: story.repo, status: story.status,
      wave: story.wave, dependsOn: story.dependsOn,
    };
  }

  const parts: string[] = ['<div class="section"><div class="section__title"><h2>Plan &amp; build</h2>'
    + `<span class="eyebrow">${dashText(plan.phase)} · ${String(plan.stories.length)} `
    + `${plan.stories.length === 1 ? "story" : "stories"}</span></div><div class="stack">`];

  if (plan.unreadable.length > 0) {
    parts.push('<div class="alert"><span class="alert__kind">unreadable</span><span>'
      + `${dashText(plan.unreadable.join(", "))} — present on disk, did not parse.</span></div>`);
  }

  for (const epic of plan.epics) {
    const rows = epic.stories.map((storyId) => {
      const story = byId[storyId];
      if (story === undefined) {
        return `<tr><td class="mono">${dashText(storyId)}</td>`
          + '<td colspan="5" class="faint">not in stories[]</td></tr>';
      }
      return `<tr><td class="mono">${dashText(storyId)}</td><td>${dashText(story.title)}</td>`
        + `<td><span class="tag">${dashText(story.repo === "" ? "—" : story.repo)}</span></td>`
        + `<td>${dashChip(story.status, null, false)}</td>`
        + `<td class="mono faint">${dashText(story.wave === null ? "—" : story.wave)}</td>`
        + '<td class="mono faint" style="font-size:var(--text-2xs)">'
        + `${dashText(story.dependsOn.length === 0 ? "—" : story.dependsOn.join(", "))}</td></tr>`;
    }).join("");
    parts.push('<div class="epic"><div class="epic__head">'
      + `<span class="mono" style="font-size:var(--text-xs)">${dashText(epic.id)}</span>`
      + `<strong>${dashText(epic.title)}</strong>${dashChip(epic.status, null, false)}`
      + `<span class="tag" style="margin-left:auto">${dashText(epic.branch === "" ? "no branch" : epic.branch)}</span></div>`
      + '<div class="scroll-x"><table><thead><tr><th>story</th><th>title</th><th>repo</th>'
      + `<th>status</th><th>wave</th><th>depends on</th></tr></thead><tbody>${rows}</tbody>`
      + "</table></div></div>");
  }

  if (plan.waves.length > 0) {
    const waves = plan.waves.map((wave, index) => {
      const chips = wave.stories.map((storyId) => {
        const story = byId[storyId];
        return `<span class="chip" data-st="${dashEscape(dashTone(story === undefined ? "" : story.status))}">`
          + `${dashText(storyId)}</span>`;
      }).join("");
      return '<div class="wave"><span class="mono" style="font-size:var(--text-xs);min-width:6em">'
        + `${dashText(wave.id)}</span>`
        + `<span class="faint mono" style="font-size:var(--text-2xs)">#${String(index + 1)}</span>`
        + `<span class="row">${chips}</span></div>`;
    }).join("");
    parts.push('<div class="card"><div class="card__head">'
      + '<h3 style="font-size:var(--text-sm)">Waves</h3>'
      + '<span class="eyebrow">file order = execution order</span></div>'
      + `${waves}</div>`);
  }

  parts.push("</div></div>");
  return parts.join("");
}

// ---------------------------------------------------------------------------
// View: experts
// ---------------------------------------------------------------------------

export function dashExpertsView(model: DashboardModel): string {
  const max = model.maxLevel;
  const head = '<div class="viewhead"><h1>Experts</h1><p>Levels are recomputed from evidence every '
    + `time the files are read — never taken from what was stored on disk. 0–${String(max)} scale.`
    + "</p></div>";
  if (model.experts.length === 0) {
    return `${head}<div class="empty">No experts in this workspace.</div>`;
  }
  return `${head}<div class="grid">${
    model.experts.map((expert) => dashExpertCard(expert, max)).join("")}</div>`;
}

export function dashExpertCard(expert: ExpertModel, max: number): string {
  const areas = expert.areas;
  const trained = areas.filter((area) => area.level > 0).length;
  const parts: string[] = [
    '<div class="card"><div class="expert__top"><div>'
      + `<div class="expert__name">${dashText(expert.name)}</div>`
      + `<div class="eyebrow" style="margin-top:2px">${dashPlural(areas.length, "area")} · `
      + `${String(trained)} above level 0</div></div>${dashChip(expert.status, null, false)}</div>`
      + '<div class="kv__k" style="margin-top:var(--space-sm)">last trained</div>'
      + '<div class="kv__v mono" style="font-size:var(--text-xs)">'
      + (expert.lastTrained === null
        ? '<span class="faint">never</span>'
        : dashText(dashDateTime(expert.lastTrained)))
      + "</div>",
  ];

  if (expert.error !== null) {
    parts.push('<div class="alert" style="margin-top:var(--space-sm)">'
      + `<span class="alert__kind">error</span><span>${dashText(expert.error)}</span></div>`);
  }
  for (const warning of expert.warnings) {
    parts.push(`<div class="warn" style="margin-top:var(--space-xs)">${dashText(warning)}</div>`);
  }
  if (areas.length >= 3) parts.push(dashRadar(expert, max));

  parts.push(`<div class="levels">${areas.map((area) => {
    const dots: string[] = [];
    for (let level = 0; level < max; level++) {
      dots.push(`<span class="dot" data-on="${level < area.level ? "1" : "0"}"></span>`);
    }
    const stored = area.storedLevel !== null && area.storedLevel !== area.level
      ? ` · stored ${String(area.storedLevel)} (not shown as level)`
      : "";
    return `<div class="level"><span class="level__title" title="${dashEscape(area.title)}">`
      + `${dashText(area.id)} <span class="faint">${dashText(area.title)}</span></span>`
      + '<span class="row"><span class="num faint" style="font-size:var(--text-2xs)">'
      + `${String(area.level)}/${String(max)}</span>`
      + `<span class="dots" role="img" aria-label="level ${String(area.level)} of ${String(max)}">`
      + `${dots.join("")}</span></span>`
      + `<span class="level__meta">${String(area.evidenceCount)} evidence`
      + (area.newestEvidence === null ? " · none yet" : ` · newest ${dashText(area.newestEvidence)}`)
      + `${dashText(stored)}</span></div>`;
  }).join("")}</div>`);

  if (areas.length > 0) {
    const first = areas[0];
    const rest = areas.slice(1);
    const more = rest.length === 0
      ? ""
      : '<details class="panel" style="border:0;margin-top:var(--space-xs)">'
        + '<summary style="padding:4px 0"><span class="caret">&#9656;</span>'
        + `<h3 class="eyebrow">${dashPlural(rest.length, "more area command")}</h3></summary>`
        + '<div class="panel__body" style="padding:var(--space-xs) 0 0;border:0">'
        + `<div class="stack stack--sm">${rest
          .map((area) => dashCmd(dashTrainCommand(area.trainPrompt), `tp-${expert.name}-${area.id}`))
          .join("")}`
        + "</div></div></details>";
    parts.push('<div style="margin-top:var(--space-md)">'
      + '<div class="kv__k" style="margin-bottom:4px">train it</div>'
      + `${dashCmd(dashTrainCommand(first === undefined ? "" : first.trainPrompt), `tp-${expert.name}`)}`
      + `${more}</div>`);
  }

  parts.push("</div>");
  return parts.join("");
}

/**
 * The train prompt, made safe to copy.
 *
 * `area.trainPrompt` is the command that RUNS training, and this page never
 * hands a reader a command that writes. `--print-prompt` turns it into the
 * read-only half: it prints the prompt and exits. A reader who wants to train
 * drops the flag themselves, deliberately.
 */
export function dashTrainCommand(trainPrompt: string): string {
  return trainPrompt === "" ? "" : `${trainPrompt} --print-prompt`;
}

/**
 * Competency as a radar, with the same numbers spelled out beside it.
 *
 * The chart is decoration over a list that already says everything — the
 * `aria-label` carries the full reading, so nothing here is chart-only.
 */
export function dashRadar(expert: ExpertModel, max: number): string {
  const areas = expert.areas;
  const count = areas.length;
  // The box is wider than the chart on purpose: axis labels sit outside the
  // outer ring, and an area id like `scavtopia-infrastructure` needs somewhere
  // to go. Anything longer than the gutter is clipped with an ellipsis — the
  // full name is in the `aria-label` and in the levels list directly below, so
  // nothing is only readable here.
  const radius = 52;
  const cx = 126;
  const cy = 72;
  const point = (index: number, distance: number): number[] => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
    return [cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance];
  };
  const polygon = (distance: number): string => areas
    .map((_area, index) => {
      const spot = point(index, distance);
      return `${(spot[0] ?? 0).toFixed(1)},${(spot[1] ?? 0).toFixed(1)}`;
    })
    .join(" ");

  const rings: string[] = [];
  for (let ring = 1; ring <= max; ring++) {
    rings.push(`<polygon points="${polygon((radius * ring) / max)}" fill="none" `
      + 'stroke="var(--line-hairline)" stroke-width="1"/>');
  }
  const spokes = areas.map((_area, index) => {
    const spot = point(index, radius);
    return `<line x1="${String(cx)}" y1="${String(cy)}" x2="${(spot[0] ?? 0).toFixed(1)}" `
      + `y2="${(spot[1] ?? 0).toFixed(1)}" stroke="var(--line-hairline)"/>`;
  }).join("");
  const values = areas.map((area, index) => {
    const spot = point(index, Math.max(0.06, area.level / max) * radius);
    return `${(spot[0] ?? 0).toFixed(1)},${(spot[1] ?? 0).toFixed(1)}`;
  }).join(" ");
  const labels = areas.map((area, index) => {
    const spot = point(index, radius + 10);
    const x = spot[0] ?? 0;
    const y = spot[1] ?? 0;
    const anchor = x > cx + 4 ? "start" : (x < cx - 4 ? "end" : "middle");
    // 14 monospace glyphs at font-size 7 is ~59px; the gutter beside the outer
    // ring is 64px (252 - 126 - 62), so a label at the horizontal extreme fits.
    const label = area.id.length > 14 ? `${area.id.slice(0, 13)}…` : area.id;
    return `<text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="${anchor}" `
      + `font-size="7" font-family="ui-monospace,monospace" fill="var(--text-faint)">`
      + `${dashText(label)}</text>`;
  }).join("");

  const alt = `${expert.name} competency: ${areas
    .map((area) => `${area.id} ${String(area.level)} of ${String(max)}`).join(", ")}`;
  return `<svg class="radar" viewBox="0 0 252 156" role="img" aria-label="${dashEscape(alt)}">`
    + `${rings.join("")}${spokes}`
    + `<polygon points="${values}" fill="var(--citron-400)" fill-opacity=".45" `
    + 'stroke="var(--citron-600)" stroke-width="1.5"/>'
    + `${labels}</svg>`;
}

// ---------------------------------------------------------------------------
// View: watchers
// ---------------------------------------------------------------------------

/**
 * `[assumption]` The model has no `watchers` field, so this view has nothing it
 * is allowed to invent.
 *
 * Watcher cards are written by the Watch phase (`src/core/watch/`), but
 * `buildModel()` does not read them yet, and inventing a card here would be a
 * dashboard claiming coverage that no file backs. So the view says exactly that,
 * prints the shape it expects, and shows the Watch stages the model *does*
 * carry, so the reader learns where the gap is rather than seeing a blank tab.
 */
export function dashWatchersView(model: DashboardModel): string {
  const parts: string[] = ['<div class="viewhead"><h1>Watchers</h1><p>One card per shipped feature: '
    + "the signal to watch, where to look, what healthy looks like, and how you would know it broke."
    + "</p></div>"];

  parts.push('<div class="empty"><strong>No watchers in this model.</strong> '
    + 'Watchers are written by the Watch phase; <code>modelVersion '
    + `${String(model.modelVersion)}</code> has no <code>watchers</code> field yet, so this view has `
    + "nothing it is allowed to invent. The cards appear here once the model carries:"
    + '<div class="spec">watchers[]: {\n  id, feature, signal, whereToLook,\n  healthyBaseline, '
    + 'brokenWhen,\n  query,            // copy-paste, text only\n  status            // "draft" | '
    + '"verified"\n}</div></div>');

  const rows: string[] = [];
  for (const run of model.runs) {
    for (const stage of run.path) {
      if (!/watch/.test(stage.phase) && !/watch/.test(stage.id)) continue;
      rows.push(`<tr><td><a href="#/run/${dashEscape(encodeURIComponent(run.id))}" class="mono" `
        + `style="color:inherit">${dashText(run.id)}</a></td>`
        + `<td class="mono">${dashText(stage.id)}</td>`
        + `<td>${dashChip(stage.status, null, false)}</td>`
        + `<td>${dashText(stage.expert === null ? "—" : stage.expert)}</td>`
        + `<td>${stage.gate === null ? '<span class="faint">none</span>' : dashText(stage.gate)}</td>`
        + "</tr>");
    }
  }
  if (rows.length > 0) {
    parts.push('<div class="section"><div class="section__title">'
      + "<h2>Watch stages in this workspace</h2>"
      + '<span class="eyebrow">from run.path</span></div>'
      + '<div class="card card--flush"><div class="scroll-x"><table><thead><tr><th>run</th>'
      + "<th>stage</th><th>status</th><th>expert</th><th>gate</th></tr></thead>"
      + `<tbody>${rows.join("")}</tbody></table></div></div></div>`);
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// View: how to use
// ---------------------------------------------------------------------------

export function dashFaqView(model: DashboardModel): string {
  const cards = model.faq.map((entry, index) =>
    `<div class="card"><h3>${dashText(entry.heading)}</h3><div class="stack stack--sm">`
    + `${entry.commands.map((command, position) =>
      dashCmd(command, `faq-${String(index)}-${String(position)}`)).join("")}</div></div>`).join("");

  return '<div class="viewhead"><h1>How to use it</h1><p>Everything happens in the terminal. '
    + "This page only reads. Copy a command, run it, watch this page catch up.</p></div>"
    + `<div class="faq">${cards}</div>`
    + '<div class="section"><div class="section__title"><h2>What this page is</h2></div>'
    + '<div class="card"><div class="prose"><p>A read-only view of <code>'
    + `${dashText(model.root)}</code>, generated from files on disk: <code>run.yml</code>, `
    + "<code>events.jsonl</code>, handoffs, questions and expert competencies. It has no write "
    + "path — no button here changes a file. Two states need a human, and only those two raise an "
    + "alert: an open <strong>question</strong> and a pending <strong>gate</strong>.</p>"
    + '<p class="muted" style="margin-top:var(--space-sm)">Read at '
    + `${dashText(dashDateTime(model.generatedAt))} · model version ${String(model.modelVersion)} · `
    + `${model.live ? "live server" : "static export"}</p></div></div></div>`;
}

/**
 * The set serialised into the page, in reading order.
 *
 * Adding a `dash*` function without adding it here is the one mistake this
 * design allows; `test/dashboard-render.test.ts` renders a fixture through the
 * serialised source, so the resulting `ReferenceError` fails a test instead of a
 * reader's page.
 */
const TEMPLATE_FUNCTIONS = [
  dashText, dashEscape, dashUsd, dashPlural, dashWords, dashDateTime, dashAgo, dashTone,
  dashChip, dashCmd, dashPending, dashSlug, dashWaitingCell, dashNextRun, dashAttention, dashChains,
  dashRoute, dashWaiting, dashTitle, dashTopMeta, dashNav,
  dashMain, dashNoWorkspace,
  dashRunsView, dashRunRow, dashMeter,
  dashRunView, dashKv, dashPathSection, dashHandoffsSection, dashPanelId, dashQuestion,
  dashPlanSection,
  dashExpertsView, dashExpertCard, dashTrainCommand, dashRadar,
  dashWatchersView,
  dashFaqView,
];
