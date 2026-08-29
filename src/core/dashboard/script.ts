/**
 * The dashboard's scripts, inlined. Two of them, and both are read-only.
 *
 * This is the DOM half of the renderer. The markup half lives in `render.ts` as
 * typed, closure-free `dash*` functions and reaches the page through
 * `clientRenderer()`; everything here is the part that cannot be a pure string
 * function — reading the embedded model, swapping `#main`, restoring scroll and
 * open panels, decorating a handoff, copying a command. Written as a string
 * rather than TypeScript because `tsconfig.json` ships no DOM lib, and pulling
 * one in to typecheck ninety lines of `document.getElementById` would put DOM
 * globals in scope for the whole CLI.
 *
 * `DASHBOARD_JS` ships in every page, static export included. It draws, it
 * filters, it copies. It has no fetch, no storage, and no control that changes a
 * file — the concept is explicit that the dashboard watches and never launches
 * (§12). The clipboard is the one thing it writes to, and that never leaves the
 * browser.
 *
 * `liveScript()` ships only when the watching server serves the page. It listens
 * on the server's `/events` stream, re-fetches `/model.json` when a file under
 * `.tldrx/` or `tldrx-work/` changes, and hands the new model back to
 * `DASHBOARD_JS` to redraw. Its only two network calls are same-origin, relative,
 * and both are GETs.
 *
 * `[assumption]` Re-rendering replaces `#main` wholesale, which would normally
 * lose the reader's place every few seconds. Three things stop that: panel ids
 * are derived from run and phase (`dashPanelId`), so an open handoff is found
 * and reopened; `scrollY` is captured and restored around the swap; and the
 * chrome is rewritten in place rather than replaced. The alternative — diffing —
 * needs a framework, and the brief rules out anything that cannot be vendored
 * into a single file.
 */

/** Path constants the server and the live page must agree on. */
export const MODEL_PATH = "/model.json";
export const EVENTS_PATH = "/events";
export const RELOAD_EVENT = "reload";

export const DASHBOARD_JS = `
(function () {
  "use strict";

  var state = { model: null, ui: { status: "all", sort: "updated" } };
  var CITE = /\\[(src|assumption|inference|inferred):?\\s*([^\\]]*)\\]/gi;

  function readEmbeddedModel() {
    var node = document.getElementById("model-data");
    if (!node) return null;
    try { return JSON.parse(node.textContent); } catch (err) { return null; }
  }

  /**
   * Style a handoff; never re-parse it.
   *
   * The model hands over Markdown already converted to HTML, with external links
   * demoted to visible text. Three passes on top: any anchor that survived is
   * demoted again (belt and braces — the page must contain no fetchable URL), a
   * wide table gets a container it can scroll inside, and every citation is
   * lifted out of the prose so it reads as a reference rather than as noise.
   */
  function decorate(root) {
    var blocks = root.querySelectorAll("[data-prose]");
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (block.getAttribute("data-decorated") === "1") continue;
      var anchors = block.querySelectorAll("a");
      for (var a = 0; a < anchors.length; a++) {
        var plain = document.createElement("span");
        plain.textContent = anchors[a].textContent;
        anchors[a].parentNode.replaceChild(plain, anchors[a]);
      }
      var tables = block.querySelectorAll("table");
      for (var t = 0; t < tables.length; t++) {
        var wrap = document.createElement("div");
        wrap.className = "scroll-x";
        tables[t].parentNode.replaceChild(wrap, tables[t]);
        wrap.appendChild(tables[t]);
      }
      markCitations(block);
      block.setAttribute("data-decorated", "1");
    }
  }

  /** \`[src: run.yml]\` becomes a citation; \`[assumption]\` becomes a flag. */
  function markCitations(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    var node;
    while ((node = walker.nextNode())) {
      CITE.lastIndex = 0;
      if (CITE.test(node.nodeValue)) nodes.push(node);
    }
    for (var i = 0; i < nodes.length; i++) {
      var text = nodes[i].nodeValue;
      var frag = document.createDocumentFragment();
      var last = 0;
      var match;
      CITE.lastIndex = 0;
      while ((match = CITE.exec(text))) {
        if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
        var kind = match[1].toLowerCase();
        var body = match[2].trim();
        var span = document.createElement("span");
        if (kind === "src") { span.className = "cite"; span.textContent = body; }
        else { span.className = "flag"; span.textContent = kind; }
        frag.appendChild(span);
        last = match.index + match[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      nodes[i].parentNode.replaceChild(frag, nodes[i]);
    }
  }

  function tldrxRender() {
    var model = state.model;
    if (!model) return;
    var main = document.getElementById("main");
    var route = dashRoute(location.hash || "");

    var open = [];
    var panels = document.querySelectorAll("details.panel[open]");
    for (var i = 0; i < panels.length; i++) if (panels[i].id) open.push(panels[i].id);
    var top = window.scrollY;

    var workspace = document.getElementById("ws");
    workspace.textContent = model.workspace || "workspace";
    workspace.title = model.root || "";
    document.getElementById("topmeta").innerHTML = dashTopMeta(model);
    document.getElementById("nav").innerHTML = dashNav(model, route.view);
    document.title = dashTitle(model);

    main.innerHTML = dashMain(model, state.ui, route, Date.now());
    for (var o = 0; o < open.length; o++) {
      var panel = document.getElementById(open[o]);
      if (panel) panel.open = true;
    }
    decorate(main);
    window.scrollTo(0, top);
  }

  function copy(button) {
    var text = button.getAttribute("data-copy");
    function done() {
      var label = button.textContent;
      button.setAttribute("data-copied", "1");
      button.textContent = "copied";
      document.getElementById("live-region").textContent = "Copied: " + text;
      setTimeout(function () {
        button.textContent = label;
        button.removeAttribute("data-copied");
      }, 1400);
    }
    function fallback() {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try { document.execCommand("copy"); done(); } catch (err) { /* nothing to offer */ }
      area.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest("button[data-copy]");
    if (button) { copy(button); return; }
    var filter = event.target.closest("[data-filter]");
    if (filter) { state.ui.status = filter.getAttribute("data-filter"); tldrxRender(); return; }
    var sort = event.target.closest("[data-sort]");
    if (sort) { state.ui.sort = sort.getAttribute("data-sort"); tldrxRender(); }
  });

  window.addEventListener("hashchange", function () {
    tldrxRender();
    window.scrollTo(0, 0);
  });

  // Pin a theme for a screenshot or a review; otherwise follow the reader's.
  var theme = /[?&]theme=(dark|light|auto)/.exec(location.search);
  if (theme) document.documentElement.setAttribute("data-theme", theme[1]);

  // The live script's one entry point: a fresh model, redrawn in place.
  window.tldrxApply = function (model) {
    state.model = model;
    tldrxRender();
  };

  state.model = readEmbeddedModel();
  tldrxRender();
})();
`.trim();

export function liveScript(): string {
  return `
(function () {
  if (typeof EventSource === "undefined" || !/^https?:$/.test(location.protocol)) return;
  var busy = false;

  function repaint() {
    if (busy) return;
    busy = true;
    fetch(${JSON.stringify(MODEL_PATH)}, { cache: "no-store" })
      .then(function (response) { return response.json(); })
      .then(function (model) { window.tldrxApply(model); })
      .catch(function () { /* the server went away; EventSource will reconnect */ })
      .then(function () { busy = false; });
  }

  var stream = new EventSource(${JSON.stringify(EVENTS_PATH)});
  stream.addEventListener(${JSON.stringify(RELOAD_EVENT)}, repaint);
  window.addEventListener("beforeunload", function () { stream.close(); });
})();
`.trim();
}
