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
  DashboardModel, ExpertModel, PhaseModel, QuestionModel, RunModel, StageRowModel,
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
  // `review` is a PLAN_STATUSES value (`schemas/planCommon.ts`) and a story
  // wearing it is in flight — it had landed in the same grey as `todo`, which
  // said the opposite of what it means.
  if (/ready|running|review|active|in_progress|working|prepared/.test(text)) return "active";
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
 * (`src/core/run/waiting.ts`). Four kinds raise a card: a gate to sign, a
 * question to answer, a stage that failed, and a `--prepare` bundle somebody has
 * to run and `--commit`. `ready` and `done` are states of the work, not asks, and
 * a page that alerts on them alerts on everything.
 *
 * `prepared` is the one that was missing. It is in `MOVABLE_KINDS`, so such a run
 * can already wear `← next` here — a row offered as the next move whose WAITING ON
 * column read "nothing" contradicted itself, and the bundle is the whole of the
 * host-attended loop (`tldrx next --prepare` writes it and releases the lock).
 *
 * A run that has NOT STARTED and is waiting behind a sibling raises nothing
 * either — the same call `tldrx status` makes when it prints no command for it.
 * Its gate is not reachable yet, and an alert that cannot be acted on is the
 * noise that makes the others ignorable.
 *
 * The "not started" half is #60. This used to suppress the alert for ANY run with
 * an unfinished `depends_on`, "whatever its own stage says" — which silenced the
 * gate of a run that had already run the stage and was sitting at it. That gate
 * IS the next move: `depends_on` is an order a split proposed, not an
 * enforcement, and it cannot make a signature unreachable after the fact.
 */
export function dashPending(run: RunModel): DashPending | null {
  if (!run.started && run.blockedBy.length > 0) return null;
  const kind = run.waiting.kind;
  if (kind === "gate") {
    return { kind: "gate", text: `stage ${run.pendingGate ?? "?"} is waiting at a gate` };
  }
  if (kind === "answer") {
    return { kind: "question", text: run.pendingQuestion ?? run.waiting.message };
  }
  if (kind === "failed") return { kind: "failed", text: run.waiting.message };
  if (kind === "prepared") return { kind: "prepared", text: run.waiting.message };
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
 * column headed "waiting on" is what made a `ready` run look finished. A run that
 * has not started says what it is behind first: a gate you cannot reach yet is
 * not the thing to go and sign.
 *
 * A run that HAS started says what it is doing (#60). "Blocked by" is reserved
 * for a run that really cannot move; the proposal it outran is a note beside its
 * own state, never the state itself.
 */
export function dashWaitingCell(run: RunModel): string {
  if (run.blockedBy.length > 0 && !run.started) {
    return `<span class="nowrap">blocked by ${dashText(run.blockedBy.map(dashSlug).join(", "))}</span>`;
  }
  const note = run.blockedBy.length === 0
    ? ""
    : `<span class="faint"> · proposed to follow ${dashText(run.blockedBy.map(dashSlug).join(", "))}`
      + " — started anyway</span>";
  const pending = dashPending(run);
  if (pending !== null) return `${dashText(pending.text)}${note}`;
  if (run.waiting.kind === "ready") {
    return `<span class="nowrap">ready — <code>tldrx next ${dashText(run.id)}</code></span>${note}`;
  }
  // Every remaining kind gets `waiting.message`, which is a whole sentence the
  // CLI already prints. The old fallback printed the run STATUS instead, and the
  // two are not the same word: a `running` run is `running` whether a live `next`
  // holds its lock or a `--prepare` bundle is waiting for a person, and "nothing
  // — running" was the answer to a question nobody asked.
  if (run.waiting.kind === "done") {
    return `<span class="faint">nothing — ${dashText(dashWords(run.status))}</span>${note}`;
  }
  return `<span class="faint">${dashText(run.waiting.message)}</span>${note}`;
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
    // #60: only a run the proposal still holds back is counted blocked.
    if (!run.started && run.blockedBy.length > 0) { blocked++; continue; }
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
    dashUnreadable(model),
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
 * The runs that are on disk and could not be read.
 *
 * Loudly, and with the parser's own words: until 2026-08-31 one unparseable
 * `run.yml` threw through `buildModel` and killed the server, so the operator's
 * evidence that anything was wrong was a stack trace and a dead page. Silently
 * dropping the run instead would have been worse — a dashboard that renders
 * cleanly while a run is missing from it is a page that lies.
 *
 * The remedy on offer is a command that prints the full diagnosis, not a button
 * that repairs anything: `tldrx run status <id>` names the file, the parse error
 * and the backup beside it.
 */
export function dashUnreadable(model: DashboardModel): string {
  if (model.unreadable.length === 0) return "";
  const rows = model.unreadable.map((run) =>
    '<div class="alert"><span class="alert__kind">unreadable</span>'
    + `<span><strong>${dashText(run.id)}</strong> — ${dashText(dashFirstLine(run.error))}`
    + '<br><span class="faint mono" style="font-size:var(--text-2xs)">'
    + `${dashText(`tldrx run status ${run.id}`)}</span></span></div>`);
  return `<div class="stack stack--sm" style="margin-bottom:var(--space-lg)">${rows.join("")}</div>`;
}

/** Parser errors carry a caret diagram on later lines; the headline is enough here. */
export function dashFirstLine(message: string): string {
  return message.split("\n")[0] ?? message;
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
    + `<div class="runrow__cell"><span class="runrow__v">${dashSpendText(run)}</span>`
    + `${dashBudgetMeter(run, false)}</div>`
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
    + dashKv("status", dashChip(run.status, null, false)
      // The exact words `tldrx run status` prints, so the two screens agree about
      // who is driving. Only when set: an ordinary run's card is unchanged.
      + (run.attendedBy === null
        ? ""
        : ` <span class="tag">attended: ${dashText(run.attendedBy)}</span>`))
    + dashKv("scope", dashText(run.scope === "" ? "—" : run.scope) + workflow)
    + dashKv("cursor", '<span class="mono" style="font-size:var(--text-xs)">'
      + `${dashText(run.cursor === null ? "—" : run.cursor)}</span>`)
    + dashKv("spent", dashSpendText(run) + dashBudgetMeter(run, true) + dashEconomies(run))
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
  parts.push(dashPlanSection(run, model.maxAttempts));
  parts.push(dashStoryArcs(run, model.maxAttempts));
  parts.push(dashBudgetSection(run));
  parts.push(dashBudgetBlocks(run));
  parts.push(dashNotesSection(run));
  return parts.join("");
}

/**
 * Who signs this gate, and who did.
 *
 * The policy is printed for every stage, `human` ones included: "which of these
 * will stop for me" is the question `run auto` makes people ask, and an answer
 * that only shows up once you have opted in is an answer nobody finds. `by` is
 * the other half — wave G put it in the model and nothing ever drew it, so an
 * `auto` gate that the facilitator closed looked identical to one a person
 * signed.
 */
export function dashGateSigner(stage: StageRowModel): string {
  const policy = `<span class="tag">${dashText(stage.gatePolicy)}</span>`;
  if (stage.gate === null) return '<span class="faint">—</span>';
  if (stage.gateBy === null) return policy;
  return `${policy} <span class="signer">by ${dashText(stage.gateBy)}</span>`
    + dashGateEvidence(stage);
}

/**
 * What an `agent` gate was signed over — or nothing, for the gates a person or
 * the facilitator closed.
 *
 * A name in the "signed by" column is enough for a human signature: the human is
 * accountable. For an agent it is not. `run.yml` records what the sub-agent
 * actually checked — the verdict, how much of the surface it sampled, how many
 * claims resolved and how many it refuted, and the run-relative path of the
 * COMMITTED note under `<phase>/gate-evidence/` — and the page dropped all of it,
 * so `agent by reviewer` and `human by alan` read as the same kind of fact.
 *
 * The path is TEXT, never a link: the page fetches nothing (`renderDashboard`).
 */
export function dashGateEvidence(stage: StageRowModel): string {
  const evidence = stage.gateEvidence;
  if (evidence === null) return "";
  const count = (value: number | null): string => (value === null ? "?" : String(value));
  const sampled = `${count(evidence.sampled)} of ${count(evidence.of)} sampled`;
  const outcome = `${count(evidence.resolved)} resolved, ${count(evidence.refuted)} refuted`;
  const outside = evidence.outsideSurface === null || evidence.outsideSurface === 0
    ? ""
    : ` · ${String(evidence.outsideSurface)} outside the surface`;
  return '<div class="evidence">'
    + `${dashChip(evidence.verdict, evidence.verdict, false)} `
    + `<span class="faint">${dashText(evidence.role)} · ${dashText(sampled)} · `
    + `${dashText(outcome)}${dashText(outside)}</span>`
    + `<div class="mono faint" style="font-size:var(--text-2xs)">${dashText(evidence.path)}</div>`
    + "</div>";
}

export function dashKv(key: string, value: string): string {
  return `<div><div class="kv__k">${dashText(key)}</div><div class="kv__v">${value}</div></div>`;
}

/**
 * The second currency, and the turns nobody costed — or nothing at all.
 *
 * `spentUsd` is a sum of what THIS process metered. On a host-attended run every
 * turn is billed to somebody's session, so the meter reads `$0.00 of $25.00`
 * after real money has gone — the exact failure `unmeteredNote`
 * (`src/core/budget/budgetView.ts`) exists to stop the CLI making, and the page
 * was making it in a progress bar. Two numbers, never added: there is no
 * exchange rate between a metered dollar and a host token, and inventing one
 * would be a guess about a price.
 *
 * Silent on an ordinary run — no tokens, no unmetered turns, nobody attending —
 * so nothing that reads correctly today gains a line.
 *
 * Since #85 the token count carries the ALLOWANCE it is judged against, which
 * comes from `budget.yml` and exists in no other file. A bare "12000 host tokens"
 * is a number with no scale: it is either a rounding error or twice the ceiling,
 * and the page had no way to say which.
 *
 * One exception, and it is about not saying the same thing twice: when the run's
 * economy IS `host-tokens`, `dashBudgetMeter` has already drawn those tokens
 * against that ceiling as the PRIMARY meter, so repeating them here left the
 * card reading "184000 host tokens of 200000 allowed" twice in four lines. There
 * this reports only the turns nobody costed — the half the meter does not carry.
 */
export function dashEconomies(run: RunModel): string {
  if (run.unmeteredTasks === 0 && run.hostTokens === 0) return "";
  const priced = run.budget !== null && run.budget.economy === "host-tokens";
  const allowance = run.budget === null || run.budget.ceilingHostTokens === null
    ? ""
    : ` of ${String(run.budget.ceilingHostTokens)} allowed`;
  const parts: string[] = [];
  if (run.hostTokens > 0 && !priced) parts.push(`${String(run.hostTokens)} host tokens${allowance}`);
  if (parts.length === 0 && run.unmeteredTasks === 0) return "";
  if (run.unmeteredTasks > 0) {
    parts.push(`${String(run.unmeteredTasks)} unmetered `
      + `${run.unmeteredTasks === 1 ? "turn" : "turns"} (in-session)`);
  }
  const bound = run.unmeteredTasks === 0
    ? ""
    : " Their cost was never declared, so spent is a LOWER BOUND, not a total.";
  return `<div class="econ"><strong>+ ${dashText(parts.join(" + "))}</strong>`
    + `<span class="faint">${dashText(bound)} Host tokens are a different currency `
    + "and are never converted to dollars.</span></div>";
}

/**
 * The dollar bar, the token bar, or neither — whichever one is TRUE here.
 *
 * `dashMeter` draws `spent / ceiling` as a fraction, and issue #85 §4 is about
 * the case where that fraction is a lie: a run whose `budget.yml` says
 * `economy: host-tokens` is not priced in dollars at all, so its `ceiling_usd`
 * governs nothing and `spent_usd` is `0.00` because nothing metered was ever
 * spent. The page drew `$0.00 of $25.00` and a 0% progress bar over it — a
 * confident statement about a denominator that does not apply.
 *
 * The honest picture needs `budget.yml`, which the model did not read until #85:
 * the ceiling those host tokens ARE judged against is `ceiling_host_tokens`, and
 * it lives nowhere else. So under a `host-tokens` economy this draws the TOKEN
 * bar and no dollar bar; under the ordinary economy it draws exactly the bar it
 * always did. The numbers over it come from `dashSpendText`, which switches
 * currency with it.
 *
 * `verbose` is the run detail, where there is room to say WHY the bar is not the
 * money one. The runs list passes false and gets the bar alone: two sentences of
 * prose inside a table cell is not a list.
 *
 * A run with no `budget.yml` — most of them — falls through to `dashMeter`
 * unchanged. Nothing that reads correctly today changes.
 */
export function dashBudgetMeter(run: RunModel, verbose: boolean): string {
  const budget = run.budget;
  if (budget === null || budget.economy !== "host-tokens") {
    return dashMeter(run.spentUsd, run.ceilingUsd);
  }
  const ceiling = budget.ceilingHostTokens;
  if (ceiling === null || ceiling === 0) {
    return !verbose
      ? ""
      : '<div class="econ"><span class="faint">budget.yml prices this run in '
        + "<code>host-tokens</code> and declares no <code>ceiling_host_tokens</code>, "
        + "so nothing bounds them.</span></div>";
  }
  const percent = Math.min(100, Math.round((run.hostTokens / ceiling) * 100));
  const bar = `<div class="meter" title="${String(percent)}% of the host-token ceiling">`
    + `<div class="meter__tok" data-over="${percent >= 90 ? "1" : "0"}" `
    + `style="width:${String(percent)}%"></div></div>`;
  return !verbose
    ? bar
    : `<div class="econ">${bar}<span class="faint">Not dollars. budget.yml prices this run in `
      + "<code>host-tokens</code>, so <code>ceiling_usd</code> governs nothing here and the "
      + "metered total is $0.00 for a reason that is not thrift.</span></div>";
}

/**
 * The two numbers over that bar — dollars, or tokens when dollars do not govern.
 *
 * The runs LIST and the run DETAIL both print a spend readout, and before #85
 * both hard-coded `spentUsd / ceilingUsd`. Suppressing only the bar under a
 * `host-tokens` economy would have left the row still reading `$0.00 of $25.00`
 * in words — the same claim the bar was making, minus the picture. One function
 * for both screens, so they cannot disagree about which currency is in force.
 */
export function dashSpendText(run: RunModel): string {
  const budget = run.budget;
  if (budget !== null && budget.economy === "host-tokens") {
    const ceiling = budget.ceilingHostTokens;
    return `<span class="num">${String(run.hostTokens)}</span> `
      + `<span class="faint">${ceiling === null
        ? "host tokens · no ceiling declared"
        : `of ${String(ceiling)} host tokens`}</span>`;
  }
  return `<span class="num">${dashText(dashUsd(run.spentUsd))}</span> `
    + `<span class="faint">of ${dashText(dashUsd(run.ceilingUsd))}</span>`;
}

/**
 * `budget.yml` itself — the per-phase ceilings, the levers, and both economies.
 *
 * Everything `tldrx budget show` exists to say and the run.yml MIRROR has never
 * carried (#85 §4). Silent on a run with no budget.yml, and on one whose copy did
 * not parse: `loadRunResult` turns that into a null rather than an exception, and
 * a panel of blanks would be worse than no panel.
 */
export function dashBudgetSection(run: RunModel): string {
  const budget = run.budget;
  if (budget === null) return "";
  const tokens = budget.ceilingHostTokens === null
    ? ""
    : dashKv("ceiling_host_tokens", `<span class="num">${String(budget.ceilingHostTokens)}</span> `
        + '<span class="faint">tokens — never dollars</span>')
      + dashKv("on_host_tokens_exceed", `<span class="tag">${dashText(budget.onHostTokensExceed)}</span>`);

  const rows = budget.phases.map((phase) => {
    const ceiling = phase.ceilingUsd === null ? "—" : dashUsd(phase.ceilingUsd);
    const spent = phase.spentUsd === null ? "—" : dashUsd(phase.spentUsd);
    const left = phase.ceilingUsd === null || phase.spentUsd === null
      ? "—"
      : dashUsd(Math.round((phase.ceilingUsd - phase.spentUsd) * 100) / 100);
    // An unset phase economy INHERITS; saying so beats printing the run's value
    // here, which would read as a choice somebody made about this phase.
    const economy = phase.economy === null
      ? `<span class="faint">inherits ${dashText(budget.economy)}</span>`
      : `<span class="tag">${dashText(phase.economy)}</span>`;
    const allowance = phase.ceilingHostTokens === null
      ? '<span class="faint">—</span>'
      : `<span class="num">${String(phase.ceilingHostTokens)}</span>`;
    return `<tr><td class="mono">${dashText(phase.id)}</td>`
      + `<td class="num">${dashText(ceiling)}</td><td class="num">${dashText(spent)}</td>`
      + `<td class="num">${dashText(left)}</td><td>${economy}</td><td class="num">${allowance}</td></tr>`;
  }).join("");

  return '<div class="section"><div class="section__title"><h2>Budget</h2>'
    + '<span class="eyebrow">budget.yml</span></div>'
    + '<div class="card"><div class="kv">'
    + dashKv("ceiling", `<span class="num">${dashText(dashUsd(budget.ceilingUsd))}</span>`)
    + dashKv("per agent max", `<span class="num">${dashText(dashUsd(budget.perAgentMaxUsd))}</span>`)
    + dashKv("economy", `<span class="tag">${dashText(budget.economy)}</span>`)
    + dashKv("on_exceed", `<span class="tag">${dashText(budget.onExceed === null ? "—" : budget.onExceed)}</span>`)
    + dashKv("warn_at_pct", `<span class="num">${budget.warnAtPct === null ? "—" : String(budget.warnAtPct)}</span>`)
    + tokens
    + '</div><div class="scroll-x"><table><thead><tr><th>phase</th><th>ceiling</th><th>spent</th>'
    + "<th>left</th><th>economy</th><th>host tokens allowed</th></tr></thead>"
    + `<tbody>${rows}</tbody></table></div></div></div>`;
}

/**
 * Every `budget.blocked` on the ledger — the moments the brake refused a stage.
 *
 * Deliberately a RECORD, not an alert. The page's rule is that a card means a run
 * is waiting on a person right now, and a refusal in the log is not evidence of
 * that: the ceiling may have been raised an hour later and the run finished since.
 * What the run is waiting on now is `waiting`, which is derived where it always
 * was and drawn where it always was.
 *
 * The dollar refusals carry the command that fixes them, in the shape
 * `raiseCommand` writes (`src/core/budget/budgetView.ts`) — pinned by a test,
 * because this function is serialised into the page and cannot import it. A
 * host-token refusal has no dollar raise, so it gets the sentence the CLI prints
 * instead of a command that would not help.
 */
export function dashBudgetBlocks(run: RunModel): string {
  if (run.budgetBlocks.length === 0) return "";
  const rows = run.budgetBlocks.map((block, index) => {
    const where = `${block.phase === null ? "—" : block.phase}`
      + `${block.stage === null ? "" : ` / ${block.stage}`}`;
    let detail: string;
    let fix: string;
    if (block.economy === "host-tokens") {
      detail = `${block.hostTokens === null ? "?" : String(block.hostTokens)} host tokens declared of `
        + `${block.ceilingTokens === null ? "?" : String(block.ceilingTokens)} allowed`;
      fix = "Raise that phase's ceiling_host_tokens in budget.yml, or set "
        + "`on_host_tokens_exceed: warn` to go back to a note.";
    } else {
      const remaining = block.remainingUsd;
      const estimate = block.estimateUsd;
      detail = `${dashUsd(remaining)} left, ${dashUsd(estimate)} needed`;
      fix = remaining === null || estimate === null
        ? "Raise the phase ceiling in budget.yml."
        : `tldrx budget raise ${block.phase ?? ""} `
          + `${Math.max(0.01, Math.ceil((estimate - remaining) * 100) / 100).toFixed(2)} --run ${run.id}`;
    }
    const reason = block.reason === null ? "" : ` <span class="faint">${dashText(block.reason)}</span>`;
    return '<div class="blocked"><div class="row">'
      + dashChip("blocked", "budget.blocked", false)
      + `<span class="mono" style="font-size:var(--text-xs)">${dashText(where)}</span>`
      + `<span class="tag">${dashText(block.economy)}</span>`
      + `<span class="faint nowrap" style="margin-left:auto">${dashText(dashDateTime(block.ts))}</span>`
      + `</div><div>${dashText(detail)}${reason}</div>`
      + (block.economy === "host-tokens"
        ? `<div class="faint">${dashText(fix)}</div>`
        : dashCmd(fix, `raise-${dashSlug(run.id)}-${String(index)}`))
      + "</div>";
  }).join("");
  return '<div class="section"><div class="section__title"><h2>Budget refusals</h2>'
    + `<span class="eyebrow">events.jsonl · ${dashPlural(run.budgetBlocks.length, "refusal")}</span></div>`
    + `<div class="stack">${rows}</div></div>`;
}

/**
 * Operator notes (`tldrx note`, #46), and the state of the ledger they came from.
 *
 * `tldrx run status` shows the last three and points at `tldrx replay` for the
 * rest, because a terminal has a bottom. This page does not, so it draws them
 * all — the issue asked which, and a run detail is the screen with room.
 *
 * It also draws when there are NO notes but the ledger is damaged, which is the
 * point: "no operator notes" over a file that could not be read is the same lie
 * by omission that an unlisted corrupt `run.yml` was.
 */
export function dashNotesSection(run: RunModel): string {
  const damaged = run.eventsError !== null || run.eventsSkipped > 0;
  if (run.notes.length === 0 && !damaged) return "";
  const rows = run.notes.map((note) => '<div class="note">'
    + `<div class="row"><strong>${dashText(note.actor)}</strong>`
    + (note.stage === null
      ? ""
      : `<span class="mono" style="font-size:var(--text-xs)">${dashText(
          note.phase === null ? note.stage : `${note.phase}/${note.stage}`)}</span>`)
    + `<span class="faint nowrap" style="margin-left:auto">${dashText(dashDateTime(note.ts))}</span></div>`
    + `<div>${dashText(note.note)}</div></div>`).join("");
  const trouble = !damaged
    ? ""
    : '<div class="alert"><span class="alert__kind">ledger</span><span>'
      + (run.eventsError === null
        ? `${dashPlural(run.eventsSkipped, "line")} of events.jsonl did not parse and `
          + "were skipped — a torn write. Anything they carried is missing from this page."
        : `events.jsonl could not be read: ${dashText(dashFirstLine(run.eventsError))}. `
          + "Nothing on this page comes from the ledger.")
      + "</span></div>";
  return '<div class="section"><div class="section__title"><h2>Operator notes</h2>'
    + `<span class="eyebrow">events.jsonl · ${dashPlural(run.notes.length, "note")}</span></div>`
    + `${trouble}<div class="stack">${rows}</div></div>`;
}

/**
 * What the ledger says happened to a story that the story FILE cannot say.
 *
 * A story's front matter carries `status` and `evidence` and no counters, so a
 * story that burned two attempts, was granted two free review re-prompts and was
 * reopened by hand for a named defect looks, on disk, exactly like one nobody
 * touched. All three facts are event-only (#85 §2 and §5).
 *
 * Silent unless something happened: an ordinary plan gains no card.
 */
export function dashStoryArcs(run: RunModel, maxAttempts: number): string {
  const plan = run.plan;
  if (plan === null) return "";
  const eventful = plan.stories.filter(
    (story) => story.reopens.length > 0 || story.reviewRetries > 0);
  if (eventful.length === 0) return "";
  const rows = eventful.map((story) => {
    const attempt = story.attempt === null
      ? ""
      : `<span class="tag">attempt ${String(story.attempt)} of ${String(maxAttempts)}</span>`;
    const retries = story.reviewRetries === 0
      ? ""
      : `<div class="faint">${dashPlural(story.reviewRetries, "free review retry")} — a review `
        + "envelope refused on its FORMAT and asked for again, costing the story no attempt.</div>";
    const reopens = story.reopens.map((reopen) => '<div class="note">'
      + `<div class="row"><span class="chip" data-st="${reopen.reason === "fix" ? "wait" : "idle"}">`
      + `${dashText(reopen.reason)}</span>`
      + `<strong>${dashText(reopen.actor)}</strong>`
      + (reopen.fromStatus === null
        ? ""
        : `<span class="faint">from ${dashText(reopen.fromStatus)}</span>`)
      + (reopen.verdicts === null
        ? ""
        : `<span class="faint">${dashPlural(reopen.verdicts, "verdict")} before it</span>`)
      + `<span class="faint nowrap" style="margin-left:auto">${dashText(dashDateTime(reopen.ts))}</span>`
      + `</div><div>${dashText(reopen.note)}</div></div>`).join("");
    return '<div class="epic"><div class="epic__head">'
      + `<span class="mono" style="font-size:var(--text-xs)">${dashText(story.id)}</span>`
      + `<strong>${dashText(story.title)}</strong>${attempt}</div>`
      + `${retries}${reopens}</div>`;
  }).join("");
  return '<div class="section"><div class="section__title"><h2>Reopens &amp; retries</h2>'
    + '<span class="eyebrow">events.jsonl</span></div>'
    + `<div class="stack">${rows}</div></div>`;
}

/** Phase → stage → expert → model → cost → gate, in `run.yml` order. */
export function dashPathSection(run: RunModel): string {
  const rows = run.path.map((stage) => {
    // Only the stage the run is actually stopped at is waiting on a human. Every
    // gate downstream of it also reads `pending`, and marking those too would
    // paint most of the table as an alert and mean nothing.
    const waits = run.pendingGate === stage.id;
    // A stale stage is `done` and its outputs are on disk, so the status chip
    // alone says "finished" about work derived from a decision that has since
    // been withdrawn (`tldrx reject --stage`). `run status` says so; this now does.
    const stale = stage.stale
      ? ' <span class="chip" data-st="wait" title="an earlier gate was revoked after '
        + 'this stage ran — its outputs are still on disk">stale</span>'
      : "";
    return `<tr${waits ? ' data-wait="1"' : ""}>`
      + `<td class="mono faint" style="font-size:var(--text-2xs)">${dashText(stage.phase)}</td>`
      + `<td class="mono">${dashText(stage.id)}</td>`
      + `<td>${dashChip(stage.status, null, false)}${stale}</td>`
      + `<td>${dashText(stage.expert === null ? "—" : stage.expert)}</td>`
      + `<td><span class="tag">${dashText(stage.model === null ? "—" : stage.model)}</span></td>`
      + `<td class="num" style="white-space:nowrap">${dashText(dashUsd(stage.costUsd))}`
      + (stage.budgetUsd === null ? "" : ` <span class="faint">/ ${dashText(dashUsd(stage.budgetUsd))}</span>`)
      + "</td>"
      + `<td>${stage.gate === null
        ? '<span class="faint">none</span>'
        : dashChip(stage.gate, stage.gate, false)}</td>`
      + `<td>${dashGateSigner(stage)}</td></tr>`;
  }).join("");

  // Counted per policy rather than as "auto and the rest" — the same arithmetic
  // `renderGates` in run/runStatus.ts does. An `agent` gate counted as human
  // inflated the one number this eyebrow exists to give: how many of these stop
  // for a person. A run gated `what:agent,plan:agent,build:agent` read as
  // all-human, which is the opposite of what it was set up to do.
  const auto = run.path.filter((stage) => stage.gatePolicy === "auto").length;
  const agent = run.path.filter((stage) => stage.gatePolicy === "agent").length;
  const human = run.path.length - auto - agent;
  return '<div class="section"><div class="section__title"><h2>Execution path</h2>'
    + `<span class="eyebrow">run.yml order · ${String(human)} human, `
    + `${String(auto)} auto${agent === 0 ? "" : `, ${String(agent)} agent`}</span></div>`
    + '<div class="card card--flush"><div class="scroll-x"><table><thead><tr>'
    + "<th>phase</th><th>stage</th><th>status</th><th>expert</th><th>model</th><th>cost</th>"
    + `<th>gate</th><th>signed by</th></tr></thead><tbody>${rows}</tbody></table></div></div></div>`;
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
export function dashPlanSection(run: RunModel, maxAttempts: number): string {
  const plan = run.plan;
  const build = dashBuildBranches(run);
  if (plan === null) {
    return '<div class="section"><div class="section__title"><h2>Plan &amp; build</h2>'
      + '<span class="eyebrow">plan · null</span></div>'
      + build
      + '<div class="empty">The Plan phase has not written stories yet. When it does, epics, '
      + "stories and waves appear here, and each story shows its status, repo and dependencies."
      + "</div></div>";
  }

  const byId: Record<string, { title: string; repo: string; status: string; wave: string | null;
    dependsOn: readonly string[]; attempt: number | null; reviewRetries: number }> = {};
  for (const story of plan.stories) {
    byId[story.id] = {
      title: story.title, repo: story.repo, status: story.status,
      wave: story.wave, dependsOn: story.dependsOn,
      attempt: story.attempt, reviewRetries: story.reviewRetries,
    };
  }

  const parts: string[] = ['<div class="section"><div class="section__title"><h2>Plan &amp; build</h2>'
    + `<span class="eyebrow">${dashText(plan.phase)} · ${String(plan.stories.length)} `
    + `${plan.stories.length === 1 ? "story" : "stories"}</span></div><div class="stack">`,
    build];

  if (plan.unreadable.length > 0) {
    parts.push('<div class="alert"><span class="alert__kind">unreadable</span><span>'
      + `${dashText(plan.unreadable.join(", "))} — present on disk, did not parse.</span></div>`);
  }

  for (const epic of plan.epics) {
    const rows = epic.stories.map((storyId) => {
      const story = byId[storyId];
      if (story === undefined) {
        return `<tr><td class="mono">${dashText(storyId)}</td>`
          + '<td colspan="6" class="faint">not in stories[]</td></tr>';
      }
      // Both event-only (#85 §2): the story FILE carries `status` and `evidence`
      // and no counters, so a story that burned both attempts and was granted two
      // free re-prompts reads on disk exactly like one nobody has picked up.
      const attempt = story.attempt === null
        ? '<span class="faint">—</span>'
        : `${String(story.attempt)} of ${String(maxAttempts)}`;
      const retries = story.reviewRetries === 0
        ? ""
        : ` <span class="faint">· ${dashPlural(story.reviewRetries, "free review retry")}</span>`;
      return `<tr><td class="mono">${dashText(storyId)}</td><td>${dashText(story.title)}</td>`
        + `<td><span class="tag">${dashText(story.repo === "" ? "—" : story.repo)}</span></td>`
        + `<td>${dashChip(story.status, null, false)}</td>`
        + `<td class="mono faint">${dashText(story.wave === null ? "—" : story.wave)}</td>`
        + `<td class="nowrap" style="font-size:var(--text-xs)">${attempt}${retries}</td>`
        + '<td class="mono faint" style="font-size:var(--text-2xs)">'
        + `${dashText(story.dependsOn.length === 0 ? "—" : story.dependsOn.join(", "))}</td></tr>`;
    }).join("");
    parts.push('<div class="epic"><div class="epic__head">'
      + `<span class="mono" style="font-size:var(--text-xs)">${dashText(epic.id)}</span>`
      + `<strong>${dashText(epic.title)}</strong>${dashChip(epic.status, null, false)}`
      + `<span class="tag" style="margin-left:auto">${dashText(epic.branch === "" ? "no branch" : epic.branch)}</span></div>`
      + '<div class="scroll-x"><table><thead><tr><th>story</th><th>title</th><th>repo</th>'
      + `<th>status</th><th>wave</th><th>attempts</th><th>depends on</th></tr></thead><tbody>${rows}</tbody>`
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

/**
 * What the Build actually cut, and under which branch model.
 *
 * The epic table above shows the branch each epic DECLARED. `run.yml` `build`
 * records what the executor cut or adopted, and `build.branch_model` (issue #57)
 * says whether those are independent per-epic branches or one integration branch
 * every story merges into — a chained epic plan and an independent one produce
 * very different git, and the page showed the same table for both.
 *
 * Silent when a run has no `build` key, which is every run before a Build stage
 * runs. A null `branch_model` is reported as unrecorded rather than guessed at:
 * it is not the same as `per-epic`.
 */
export function dashBuildBranches(run: RunModel): string {
  const build = run.build;
  if (build === null) return "";
  const model = build.branchModel === null
    ? '<span class="faint">not recorded — this run predates <code>build.branch_model</code></span>'
    : `<span class="tag">${dashText(build.branchModel)}</span>`;
  const branches = build.epicBranches.length === 0
    ? '<span class="faint">none cut yet</span>'
    : build.epicBranches.map((branch) => `<span class="tag">${dashText(branch)}</span>`).join(" ");
  return '<div class="card"><div class="card__head">'
    + '<h3 style="font-size:var(--text-sm)">Branches</h3>'
    + '<span class="eyebrow">run.yml · build</span></div>'
    + `<div class="kv"><div><div class="kv__k">branch model</div><div class="kv__v">${model}</div></div>`
    + `<div><div class="kv__k">epic branches</div><div class="kv__v row">${branches}</div></div>`
    + "</div></div>";
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
 *
 * The shape it prints is now the REAL one — `Watcher` in
 * `src/core/watch/Watcher.ts`, plus where the cards live and what decides
 * `draft` vs `verified`. It used to print an invented shape
 * (`feature`, `signal`, `whereToLook`, `healthyBaseline`, `brokenWhen`) whose
 * field names matched none of the seven the file actually carries, so the one
 * thing this view existed to be honest about was itself wrong.
 */
export function dashWatchersView(model: DashboardModel): string {
  const parts: string[] = ['<div class="viewhead"><h1>Watchers</h1><p>One card per shipped feature: '
    + "the signal to watch, where to look, what healthy looks like, and how you would know it broke."
    + "</p></div>"];

  parts.push('<div class="empty"><strong>No watchers in this model.</strong> '
    + "Watchers are written by the Watch phase to "
    + "<code>&lt;run&gt;/05-watch/watchers/&lt;feature&gt;.md</code>; <code>modelVersion "
    + `${String(model.modelVersion)}</code> has no <code>watchers</code> field yet, so this view has `
    + "nothing it is allowed to invent. Read them with <code>tldrx watch list</code>, or check them "
    + "against today's code with <code>tldrx watch check</code>. The cards appear here once the "
    + "model carries the front matter those files already have:"
    + '<div class="spec">watchers[]: {\n  id, epic, title,\n  stories, repos,\n  owner,'
    + '            // string | null\n  status            // "verified" when every Signal item\n'
    + '                    // was found in the code, else "draft"\n}</div></div>');

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
    + "<code>budget.yml</code>, <code>events.jsonl</code>, handoffs, questions, the Plan "
    + "artefacts and expert competencies. It has no write path — no button here changes a file.</p>"
    // This paragraph used to say the opposite, and was true when it was written:
    // until #85 the model read neither file, which is why a reader could not find
    // their own operator notes here. Both are read now, so the honest sentence is
    // the one that says what is STILL only in the ledger.
    + "<p>From the ledger it takes operator notes (<code>tldrx note</code>), the attempt each "
    + "story is on, the free review retries it was granted, story reopens and the moments the "
    + "budget brake refused a stage. Per-attempt costs and the full narrative order are still "
    + "<code>tldrx replay &lt;run&gt;</code>'s job.</p>"
    + "<p>Four states need a human, and only those raise an alert: an open <strong>question</strong>, "
    + "a pending <strong>gate</strong>, a <strong>failed</strong> stage, and a "
    + "<code>--prepare</code> bundle waiting to be run and committed.</p>"
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
  dashRunsView, dashUnreadable, dashFirstLine, dashRunRow, dashMeter,
  dashRunView, dashGateSigner, dashGateEvidence, dashKv, dashEconomies,
  dashBudgetMeter, dashSpendText, dashBudgetSection, dashBudgetBlocks, dashNotesSection, dashStoryArcs,
  dashPathSection, dashHandoffsSection, dashPanelId, dashQuestion,
  dashPlanSection, dashBuildBranches,
  dashExpertsView, dashExpertCard, dashTrainCommand, dashRadar,
  dashWatchersView,
  dashFaqView,
];
