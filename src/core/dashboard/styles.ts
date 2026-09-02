/**
 * The dashboard's entire stylesheet, inlined.
 *
 * These are the design system's own tokens and components, vendored. No external
 * URL of any kind — no CDN, no font host, no image host — because the export is a
 * single file meant to be mailed, committed or opened offline. The type stacks
 * name system fonts as the substitutes for the design's licensed faces rather
 * than fetching them.
 *
 * Colour lives in tokens on `:root` and is redefined once for dark. The page
 * follows the reader's theme rather than picking one for them: `<html>` ships
 * `data-theme="auto"`, `prefers-color-scheme: dark` swaps the tokens under it,
 * and `data-theme="dark"`/`"light"` (set from `?theme=`) pins one for a
 * screenshot. Both themes are held to WCAG AA on body text.
 *
 * One loud colour — citron — and it is spent only on the two states that need a
 * human: an open question and a pending gate. Everything else is paper and ink.
 */
export const DASHBOARD_CSS = `
/* ============================================================
   DESIGN TOKENS — tldrx design system, vendored (no CDN, no webfonts)
   ============================================================ */
:root{
  /* fonts: system stacks substituting Instrument Sans / Serif / JetBrains Mono */
  --font-core: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-editorial: Georgia, "Iowan Old Style", "Times New Roman", serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  /* paper / ink */
  --paper-000:#FFFDF8; --paper-050:#F8F5ED; --paper-100:#F0ECE1;
  --paper-200:#E3DED0; --paper-300:#CFC8B6;
  --ink-400:#918B7C; --ink-500:#6E6859; --ink-600:#514C41;
  --ink-700:#38352E; --ink-800:#232220; --ink-900:#141312;

  /* citron — the one loud color */
  --citron-100:#FBFFE4; --citron-200:#F4FFB8; --citron-300:#EDFF8A;
  --citron-400:#E4FF57; --citron-500:#CFEE2B; --citron-600:#A8C310;

  /* signal / support */
  --signal-400:#FF7550; --signal-500:#FF4A1C; --signal-600:#DB3510;
  --moss-500:#2E9E6B; --moss-100:#E2F5EC;
  --amber-500:#EFA400; --amber-100:#FDF1D6;
  --slate-500:#4A6280; --slate-100:#E7ECF3;

  /* surfaces */
  --surface-page:var(--paper-050);
  --surface-card:var(--paper-000);
  --surface-sunken:var(--paper-100);
  --surface-accent:var(--citron-400);
  --surface-accent-soft:var(--citron-200);
  --surface-inverse:var(--ink-900);

  /* text */
  --text-display:var(--ink-900); --text-body:var(--ink-800);
  --text-muted:var(--ink-500); --text-faint:var(--ink-400);
  --text-on-accent:var(--ink-900); --text-on-inverse:var(--paper-050);
  --text-danger:var(--signal-600);

  /* lines */
  --line-hairline:var(--paper-200); --line-strong:var(--ink-900);
  --line-focus:var(--ink-900);
  --focus-ring:0 0 0 2px var(--surface-page), 0 0 0 4px var(--line-focus);

  /* type ramp */
  --text-2xs:11px; --text-xs:12px; --text-sm:13px; --text-md:15px;
  --text-lg:17px; --text-xl:21px; --text-2xl:27px; --text-3xl:36px;
  --leading-tight:1.06; --leading-snug:1.22; --leading-normal:1.5; --leading-relaxed:1.62;
  --weight-regular:400; --weight-medium:500; --weight-semibold:600; --weight-bold:700;
  --tracking-tight:-.022em; --tracking-snug:-.012em; --tracking-wide:.06em; --tracking-caps:.12em;

  /* spacing */
  --space-2xs:4px; --space-xs:8px; --space-sm:12px; --space-md:16px;
  --space-lg:24px; --space-xl:32px; --space-2xl:48px; --space-3xl:64px;

  /* radii, shadows, motion */
  --radius-xs:2px; --radius-sm:4px; --radius-md:8px; --radius-lg:12px; --radius-pill:999px;
  --shadow-hard-1:2px 2px 0 var(--ink-900);
  --dur-fast:120ms; --dur-med:220ms; --ease-out:cubic-bezier(.2,.7,.3,1);

  /* status semantics (dashboard-local, built from DS support colors) */
  --st-done:var(--moss-500);      --st-done-bg:var(--moss-100);
  --st-active:var(--citron-600);  --st-active-bg:var(--citron-200);
  --st-wait:var(--signal-600);    --st-wait-bg:#FFE7DF;
  --st-idle:var(--ink-400);       --st-idle-bg:var(--paper-100);
  --st-off:var(--slate-500);      --st-off-bg:var(--slate-100);
}
@media (prefers-color-scheme: dark){
  :root[data-theme="auto"]{ color-scheme: dark; }
}
:root[data-theme="dark"]{ color-scheme: dark; }
:root[data-theme="dark"], :root[data-theme="auto"]{ }
@media (prefers-color-scheme: dark){
  :root[data-theme="auto"]{
    --surface-page:#111110; --surface-card:#1B1A18; --surface-sunken:#232220;
    --text-display:#FBF9F3; --text-body:#EDEAE1; --text-muted:#A9A395; --text-faint:#8B8577;
    --line-hairline:#332F29; --line-strong:#4A453C; --line-focus:var(--citron-400);
    --focus-ring:0 0 0 2px var(--surface-page), 0 0 0 4px var(--citron-400);
    --text-danger:var(--signal-400);
    --shadow-hard-1:2px 2px 0 #000;
    --st-done:#5FD39B;  --st-done-bg:#16301F;
    --st-active:var(--citron-400); --st-active-bg:#2F3410;
    --st-wait:var(--signal-400); --st-wait-bg:#3A1508;
    --st-idle:#8B8577;  --st-idle-bg:#26241F;
    --st-off:#8FA6C2;   --st-off-bg:#1D2733;
  }
}
:root[data-theme="dark"]{
  --surface-page:#111110; --surface-card:#1B1A18; --surface-sunken:#232220;
  --text-display:#FBF9F3; --text-body:#EDEAE1; --text-muted:#A9A395; --text-faint:#8B8577;
  --line-hairline:#332F29; --line-strong:#4A453C; --line-focus:var(--citron-400);
  --focus-ring:0 0 0 2px var(--surface-page), 0 0 0 4px var(--citron-400);
  --text-danger:var(--signal-400);
  --shadow-hard-1:2px 2px 0 #000;
  --st-done:#5FD39B;  --st-done-bg:#16301F;
  --st-active:var(--citron-400); --st-active-bg:#2F3410;
  --st-wait:var(--signal-400); --st-wait-bg:#3A1508;
  --st-idle:#8B8577;  --st-idle-bg:#26241F;
  --st-off:#8FA6C2;   --st-off-bg:#1D2733;
}

/* ============================================================
   BASE
   ============================================================ */
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--surface-page);color:var(--text-body);
  font-family:var(--font-core);font-size:var(--text-md);line-height:var(--leading-relaxed);
  -webkit-font-smoothing:antialiased}
h1,h2,h3,h4{margin:0;font-weight:var(--weight-semibold);letter-spacing:var(--tracking-snug);
  line-height:var(--leading-snug);color:var(--text-display)}
p{margin:0;text-wrap:pretty}
ul,ol{margin:0}
code,kbd,pre,samp{font-family:var(--font-mono)}
button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
:focus-visible{outline:none;box-shadow:var(--focus-ring)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
.mono{font-family:var(--font-mono)}
.eyebrow{font-family:var(--font-mono);font-size:var(--text-2xs);letter-spacing:var(--tracking-caps);
  text-transform:uppercase;color:var(--text-muted)}
.num{font-family:var(--font-mono);font-variant-numeric:tabular-nums}
.muted{color:var(--text-muted)}
.faint{color:var(--text-faint)}
.scroll-x{overflow-x:auto;-webkit-overflow-scrolling:touch}

/* ============================================================
   SHELL
   ============================================================ */
.shell{max-width:1180px;margin:0 auto;padding:0 var(--space-lg) var(--space-3xl)}
.topbar{position:sticky;top:0;z-index:20;background:var(--surface-page);
  border-bottom:1px solid var(--line-hairline)}
.topbar__in{max-width:1180px;margin:0 auto;padding:var(--space-sm) var(--space-lg);
  display:flex;flex-wrap:wrap;gap:var(--space-sm) var(--space-lg);align-items:baseline}
.brand{display:flex;align-items:baseline;gap:var(--space-xs);min-width:0}
.brand__mark{font-family:var(--font-mono);font-weight:var(--weight-bold);font-size:var(--text-sm);
  letter-spacing:var(--tracking-wide);background:var(--surface-accent);color:var(--text-on-accent);
  padding:2px 6px;border-radius:var(--radius-xs)}
.brand__ws{font-size:var(--text-lg);font-weight:var(--weight-semibold);color:var(--text-display);
  letter-spacing:var(--tracking-snug);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar__meta{margin-left:auto;display:flex;gap:var(--space-md);align-items:center;
  font-family:var(--font-mono);font-size:var(--text-2xs);color:var(--text-muted);
  letter-spacing:var(--tracking-wide)}
.live{display:inline-flex;align-items:center;gap:6px;text-transform:uppercase}
.live__dot{width:7px;height:7px;border-radius:50%;background:var(--st-done)}
.live--off .live__dot{background:var(--st-idle)}

.nav{max-width:1180px;margin:0 auto;padding:0 var(--space-lg);display:flex;gap:2px;
  overflow-x:auto;scrollbar-width:none}
.nav::-webkit-scrollbar{display:none}
.tab{font-family:var(--font-mono);font-size:var(--text-xs);letter-spacing:var(--tracking-wide);
  text-transform:uppercase;color:var(--text-muted);padding:10px var(--space-sm);
  border-bottom:2px solid transparent;white-space:nowrap;transition:color var(--dur-fast) var(--ease-out)}
.tab:hover{color:var(--text-body)}
.tab[aria-current="page"]{color:var(--text-display);border-bottom-color:var(--line-focus);
  font-weight:var(--weight-bold)}
.tab__count{margin-left:6px;color:var(--st-wait);font-weight:var(--weight-bold)}

.viewhead{padding:var(--space-xl) 0 var(--space-md)}
.viewhead h1{font-family:var(--font-editorial);font-weight:var(--weight-regular);
  font-size:var(--text-3xl);line-height:var(--leading-tight);letter-spacing:var(--tracking-tight)}
.viewhead p{margin-top:var(--space-xs);color:var(--text-muted);font-size:var(--text-sm);max-width:60ch}

/* ============================================================
   PRIMITIVES
   ============================================================ */
.chip{display:inline-flex;align-items:center;gap:5px;font-family:var(--font-mono);
  font-size:var(--text-2xs);letter-spacing:var(--tracking-wide);text-transform:uppercase;
  padding:3px 7px;border-radius:var(--radius-xs);background:var(--st-idle-bg);color:var(--text-body);
  border:1px solid transparent;white-space:nowrap}
.chip::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--st-idle);flex:none}
.chip--plain::before{display:none}
.chip[data-st="done"]{background:var(--st-done-bg)}   .chip[data-st="done"]::before{background:var(--st-done)}
.chip[data-st="active"]{background:var(--st-active-bg)} .chip[data-st="active"]::before{background:var(--st-active)}
.chip[data-st="wait"]{background:var(--st-wait-bg);border-color:var(--st-wait)} .chip[data-st="wait"]::before{background:var(--st-wait)}
.chip[data-st="off"]{background:var(--st-off-bg)}      .chip[data-st="off"]::before{background:var(--st-off)}
.tag{display:inline-block;font-family:var(--font-mono);font-size:var(--text-2xs);
  padding:2px 6px;border-radius:var(--radius-xs);background:var(--surface-sunken);
  color:var(--text-muted);letter-spacing:var(--tracking-wide);white-space:nowrap}

.card{background:var(--surface-card);border:1px solid var(--line-hairline);
  border-radius:var(--radius-md);padding:var(--space-lg)}
.card--flush{padding:0;overflow:hidden}
.card__head{display:flex;flex-wrap:wrap;gap:var(--space-sm);align-items:baseline;
  justify-content:space-between;margin-bottom:var(--space-md)}
.stack{display:flex;flex-direction:column;gap:var(--space-md)}
.stack--sm{gap:var(--space-xs)}
.row{display:flex;flex-wrap:wrap;gap:var(--space-xs);align-items:center}

.section{margin-top:var(--space-xl)}
.section__title{display:flex;align-items:baseline;gap:var(--space-sm);
  padding-bottom:var(--space-xs);margin-bottom:var(--space-md);
  border-bottom:1px solid var(--line-hairline)}
.section__title h2{font-size:var(--text-lg)}

.empty{border:1px dashed var(--line-hairline);border-radius:var(--radius-md);
  padding:var(--space-lg);color:var(--text-muted);font-size:var(--text-sm);background:var(--surface-card)}
.empty strong{color:var(--text-body)}

/* copy-paste command */
.cmd{display:flex;align-items:stretch;gap:0;background:var(--surface-sunken);
  border:1px solid var(--line-hairline);border-radius:var(--radius-sm);overflow:hidden}
.cmd code{flex:1;min-width:0;padding:8px var(--space-sm);font-size:var(--text-xs);
  line-height:var(--leading-normal);overflow-x:auto;white-space:pre;color:var(--text-body)}
.cmd code::before{content:"$ ";color:var(--text-faint)}
.cmd button{flex:none;padding:0 var(--space-sm);font-family:var(--font-mono);font-size:var(--text-2xs);
  letter-spacing:var(--tracking-wide);text-transform:uppercase;color:var(--text-muted);
  border-left:1px solid var(--line-hairline);transition:background var(--dur-fast) var(--ease-out)}
.cmd button:hover{background:var(--surface-accent);color:var(--text-on-accent)}
.cmd button[data-copied="1"]{background:var(--st-done-bg);color:var(--st-done)}

/* progress: stage pips + budget meter */
.pips{display:flex;gap:3px;align-items:center}
.pip{width:16px;height:6px;border-radius:1px;background:var(--st-idle-bg);flex:none}
.pip[data-st="done"]{background:var(--st-done)}
.pip[data-st="active"]{background:var(--st-active)}
.pip[data-st="wait"]{background:var(--st-wait)}
.pip[data-st="off"]{background:var(--st-off)}
.meter{height:6px;border-radius:1px;background:var(--surface-sunken);overflow:hidden;min-width:80px}
.meter__fill{height:100%;background:var(--text-faint)}
.meter__fill[data-over="1"]{background:var(--st-wait)}

/* alert strip — only for pending question / pending gate */
.alert{display:flex;gap:var(--space-sm);align-items:flex-start;
  border:1px solid var(--st-wait);border-left-width:3px;background:var(--st-wait-bg);
  border-radius:var(--radius-sm);padding:var(--space-sm) var(--space-md);font-size:var(--text-sm)}
.alert__kind{font-family:var(--font-mono);font-size:var(--text-2xs);text-transform:uppercase;
  letter-spacing:var(--tracking-caps);color:var(--st-wait);font-weight:var(--weight-bold);
  padding-top:3px;flex:none}
.alert a{color:var(--text-display);text-decoration:underline;text-decoration-color:var(--st-wait)}

/* tables */
table{border-collapse:collapse;width:100%;font-size:var(--text-sm)}
th{text-align:left;font-family:var(--font-mono);font-size:var(--text-2xs);font-weight:var(--weight-medium);
  text-transform:uppercase;letter-spacing:var(--tracking-caps);color:var(--text-muted);
  padding:var(--space-xs) var(--space-sm);border-bottom:1px solid var(--line-strong);white-space:nowrap}
td{padding:10px var(--space-sm);border-bottom:1px solid var(--line-hairline);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tr[data-wait="1"] td{background:var(--st-wait-bg)}
.signer{font-family:var(--font-mono);font-size:var(--text-2xs);color:var(--text-muted);
  white-space:nowrap}
/* what an agent gate was signed over — under the signer, never beside it:
   a sampled count that wraps into the name reads as part of the name */
.evidence{margin-top:6px;font-size:var(--text-2xs);line-height:var(--leading-normal);
  max-width:34ch}
/* the second currency, under the money meter it qualifies */
.econ{margin-top:6px;font-size:var(--text-2xs);line-height:var(--leading-normal)}
.econ .faint{display:block}
/* the HOST-TOKEN bar. A distinct class rather than a modifier on .meter__fill:
   a token allowance and a dollar ceiling are not the same measurement, and the
   one thing this bar must never do is read as the money one (#85). */
.meter__tok{height:100%;background:var(--st-active)}
.meter__tok[data-over="1"]{background:var(--st-wait)}

/* one operator note, one reopen: a byline row over the words themselves */
.note{padding:var(--space-sm) var(--space-md);border:1px solid var(--line-hairline);
  border-radius:2px;background:var(--surface-sunken);font-size:var(--text-xs);
  line-height:var(--leading-normal)}
.note .row{margin-bottom:4px;align-items:baseline}
/* a moment the budget brake refused a stage — history, so it is a card and
   never an alert; the page's alerts mean "a person is needed NOW" */
.blocked{padding:var(--space-sm) var(--space-md);border:1px solid var(--line-hairline);
  border-left:2px solid var(--st-wait);border-radius:2px;font-size:var(--text-xs);
  line-height:var(--leading-normal)}
.blocked .row{margin-bottom:4px;align-items:baseline}

/* attention summary: the three counts tldrx status opens with */
.attn{display:flex;flex-wrap:wrap;gap:var(--space-xs);align-items:center;
  font-family:var(--font-mono);font-size:var(--text-xs);margin-bottom:var(--space-md)}
.attn__n{color:var(--text-muted)}
.attn__n[data-st="active"]{color:var(--st-active);font-weight:var(--weight-semibold)}
.attn__n[data-st="wait"]{color:var(--st-wait);font-weight:var(--weight-semibold)}
.attn__sep{color:var(--text-faint)}
.attn__cmd{background:var(--surface-sunken);border:1px solid var(--line-hairline);
  border-radius:var(--radius-sm);padding:2px 6px;font-size:var(--text-2xs);color:var(--text-body)}

/* dependency chain — one line per root-to-leaf path */
.chain{display:flex;flex-wrap:wrap;gap:var(--space-2xs);align-items:center;
  font-family:var(--font-mono);font-size:var(--text-xs);line-height:var(--leading-relaxed)}
.chain + .chain{margin-top:var(--space-xs)}
.chain__link{color:var(--text-muted);text-decoration:none;border-radius:var(--radius-sm);
  padding:1px 5px;border:1px solid transparent}
.chain__link:hover{border-color:var(--line-hairline);color:var(--text-body)}
.chain__link[data-st="done"]{color:var(--st-done)}
.chain__link[data-st="active"]{color:var(--text-on-accent);background:var(--surface-accent);
  border-color:var(--surface-accent);font-weight:var(--weight-semibold)}
.chain__arrow{color:var(--text-faint)}

/* ============================================================
   RUNS LIST
   ============================================================ */
.filters{display:flex;flex-wrap:wrap;gap:var(--space-xs);align-items:center;
  margin-bottom:var(--space-md)}
.filters__label{font-family:var(--font-mono);font-size:var(--text-2xs);text-transform:uppercase;
  letter-spacing:var(--tracking-caps);color:var(--text-faint);margin-right:var(--space-2xs)}
.fbtn{font-family:var(--font-mono);font-size:var(--text-2xs);letter-spacing:var(--tracking-wide);
  text-transform:uppercase;padding:4px 9px;border-radius:var(--radius-pill);
  border:1px solid var(--line-hairline);color:var(--text-muted)}
.fbtn:hover{border-color:var(--line-strong);color:var(--text-body)}
.fbtn[aria-pressed="true"]{background:var(--surface-inverse);color:var(--text-on-inverse);
  border-color:var(--surface-inverse)}
@media (prefers-color-scheme: dark){:root[data-theme="auto"] .fbtn[aria-pressed="true"]{
  background:var(--citron-400);color:var(--ink-900);border-color:var(--citron-400)}}
:root[data-theme="dark"] .fbtn[aria-pressed="true"]{background:var(--citron-400);color:var(--ink-900);border-color:var(--citron-400)}

.runrow{display:grid;grid-template-columns:minmax(0,2.4fr) 132px 150px 120px minmax(0,1.6fr);
  gap:var(--space-md);align-items:center;padding:var(--space-md);
  border-bottom:1px solid var(--line-hairline);text-decoration:none;color:inherit;
  transition:background var(--dur-fast) var(--ease-out)}
.runrow:last-child{border-bottom:0}
.runrow:hover{background:var(--surface-sunken)}
.runrow__id{font-family:var(--font-mono);font-size:var(--text-2xs);color:var(--text-faint);
  letter-spacing:var(--tracking-wide)}
.runrow__next{margin-left:var(--space-xs);padding:1px 6px;border-radius:var(--radius-pill);
  background:var(--surface-accent);color:var(--text-on-accent);font-weight:var(--weight-bold);
  letter-spacing:var(--tracking-wide)}
.runrow__title{font-size:var(--text-md);font-weight:var(--weight-semibold);color:var(--text-display);
  letter-spacing:var(--tracking-snug);margin-top:2px}
.runrow__sub{font-family:var(--font-mono);font-size:var(--text-2xs);color:var(--text-muted);margin-top:4px}
.runrow__cell{display:flex;flex-direction:column;gap:5px;align-items:flex-start}
.runrow__k{font-family:var(--font-mono);font-size:var(--text-2xs);text-transform:uppercase;
  letter-spacing:var(--tracking-caps);color:var(--text-faint)}
.runrow__v{font-family:var(--font-mono);font-size:var(--text-xs);color:var(--text-body)}
.runrow__wait{font-size:var(--text-xs);line-height:var(--leading-normal)}
.runrow__wait[data-wait="1"]{color:var(--st-wait);font-weight:var(--weight-semibold)}
.runhead{display:grid;grid-template-columns:minmax(0,2.4fr) 132px 150px 120px minmax(0,1.6fr);
  gap:var(--space-md);padding:var(--space-xs) var(--space-md);background:var(--surface-sunken);
  border-bottom:1px solid var(--line-strong)}
.runhead span{font-family:var(--font-mono);font-size:var(--text-2xs);text-transform:uppercase;
  letter-spacing:var(--tracking-caps);color:var(--text-muted)}
@media (max-width:860px){
  .runhead{display:none}
  .runrow{grid-template-columns:1fr 1fr;gap:var(--space-sm) var(--space-md)}
  .runrow > :first-child{grid-column:1 / -1}
  .runrow__wait{grid-column:1 / -1}
}

/* ============================================================
   RUN DETAIL
   ============================================================ */
.backlink{display:inline-flex;align-items:center;gap:6px;font-family:var(--font-mono);
  font-size:var(--text-2xs);text-transform:uppercase;letter-spacing:var(--tracking-caps);
  color:var(--text-muted);text-decoration:none;padding-top:var(--space-lg)}
.backlink:hover{color:var(--text-display)}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--space-md)}
.kv__k{font-family:var(--font-mono);font-size:var(--text-2xs);text-transform:uppercase;
  letter-spacing:var(--tracking-caps);color:var(--text-faint)}
.kv__v{font-size:var(--text-sm);color:var(--text-body);margin-top:4px}
.kv__v .nowrap{white-space:nowrap}
.kv__v .num{font-size:var(--text-lg);letter-spacing:var(--tracking-snug)}

/* handoff prose */
details.panel{background:var(--surface-card);border:1px solid var(--line-hairline);
  border-radius:var(--radius-md);overflow:hidden}
details.panel > summary{list-style:none;cursor:pointer;padding:var(--space-sm) var(--space-md);
  display:flex;gap:var(--space-sm);align-items:center;background:var(--surface-card)}
details.panel > summary::-webkit-details-marker{display:none}
details.panel > summary:hover{background:var(--surface-sunken)}
details.panel > summary .caret{font-family:var(--font-mono);font-size:var(--text-xs);
  color:var(--text-faint);transition:transform var(--dur-fast) var(--ease-out)}
details.panel[open] > summary .caret{transform:rotate(90deg)}
details.panel > summary h3{font-size:var(--text-sm);flex:1;min-width:0}
.panel__body{padding:var(--space-md) var(--space-lg) var(--space-lg);
  border-top:1px solid var(--line-hairline)}

.prose{font-size:var(--text-sm);line-height:var(--leading-relaxed);max-width:78ch}
.prose h1{font-family:var(--font-editorial);font-weight:var(--weight-regular);font-size:var(--text-xl);
  letter-spacing:var(--tracking-tight);margin:0 0 var(--space-xs)}
.prose h2{font-size:var(--text-md);margin:var(--space-lg) 0 var(--space-xs);
  padding-bottom:4px;border-bottom:1px solid var(--line-hairline)}
.prose h3,.prose h4{font-size:var(--text-sm);margin:var(--space-md) 0 var(--space-2xs)}
.prose p{margin:var(--space-xs) 0}
.prose ul,.prose ol{margin:var(--space-xs) 0;padding-left:var(--space-md)}
.prose li{margin:var(--space-xs) 0;padding-left:2px}
.prose li::marker{color:var(--text-faint)}
.prose code{font-size:.92em;background:var(--surface-sunken);padding:1px 4px;border-radius:var(--radius-xs)}
.prose table{margin:var(--space-sm) 0;font-size:var(--text-xs)}
.prose strong{font-weight:var(--weight-semibold);color:var(--text-display)}
.prose hr{border:0;border-top:1px solid var(--line-hairline);margin:var(--space-lg) 0}
/* citations are first-class */
.cite{font-family:var(--font-mono);font-size:var(--text-2xs);letter-spacing:0;
  color:var(--text-muted);background:var(--surface-sunken);
  border:1px solid var(--line-hairline);border-radius:var(--radius-xs);
  padding:1px 5px;margin-left:4px;white-space:normal;word-break:break-word}
.cite::before{content:"src ";color:var(--text-faint)}
.flag{font-family:var(--font-mono);font-size:var(--text-2xs);text-transform:uppercase;
  letter-spacing:var(--tracking-wide);padding:1px 5px;border-radius:var(--radius-xs);
  background:var(--amber-100);color:#8A5D00;margin:0 2px}
@media (prefers-color-scheme: dark){:root[data-theme="auto"] .flag{background:#3A2C08;color:var(--amber-500)}}
:root[data-theme="dark"] .flag{background:#3A2C08;color:var(--amber-500)}

/* question */
.q{border:1px solid var(--st-wait);border-radius:var(--radius-md);background:var(--surface-card);
  overflow:hidden}
.q__head{padding:var(--space-sm) var(--space-md);background:var(--st-wait-bg);
  border-bottom:1px solid var(--st-wait);display:flex;gap:var(--space-sm);align-items:baseline}
.q__id{font-family:var(--font-mono);font-weight:var(--weight-bold);font-size:var(--text-xs);
  color:var(--st-wait)}
.q__title{font-size:var(--text-md);font-weight:var(--weight-semibold);color:var(--text-display)}
.q__body{padding:var(--space-md);display:flex;flex-direction:column;gap:var(--space-sm)}
.opt{display:flex;gap:var(--space-sm);font-size:var(--text-sm)}
.opt__letter{font-family:var(--font-mono);font-weight:var(--weight-bold);flex:none;width:1.4em;
  color:var(--text-display)}

/* plan */
.epic{border:1px solid var(--line-hairline);border-radius:var(--radius-md);overflow:hidden;
  background:var(--surface-card)}
.epic__head{padding:var(--space-sm) var(--space-md);background:var(--surface-sunken);
  display:flex;flex-wrap:wrap;gap:var(--space-sm);align-items:baseline}
.wave{display:flex;gap:var(--space-sm);align-items:baseline;padding:var(--space-xs) 0;
  border-bottom:1px solid var(--line-hairline)}
.wave:last-child{border-bottom:0}

/* ============================================================
   EXPERTS
   ============================================================ */
.grid{display:grid;gap:var(--space-md);grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
.expert__top{display:flex;gap:var(--space-sm);align-items:baseline;justify-content:space-between}
.expert__name{font-size:var(--text-lg);font-weight:var(--weight-semibold);color:var(--text-display)}
.radar{display:block;width:100%;height:auto;max-width:280px;margin:var(--space-sm) auto}
.levels{display:flex;flex-direction:column;gap:var(--space-xs);margin-top:var(--space-sm)}
.level{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--space-xs) var(--space-sm);
  align-items:center;font-size:var(--text-sm)}
.level__title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dots{display:flex;gap:3px}
.dot{width:9px;height:9px;border-radius:50%;border:1px solid var(--line-strong);flex:none}
.dot[data-on="1"]{background:var(--surface-accent);border-color:var(--citron-600)}
.level__meta{grid-column:1 / -1;font-family:var(--font-mono);font-size:var(--text-2xs);
  color:var(--text-faint)}
.warn{font-size:var(--text-xs);color:var(--st-wait);display:flex;gap:6px}
.warn::before{content:"!";font-family:var(--font-mono);font-weight:var(--weight-bold)}

/* ============================================================
   WATCHERS
   ============================================================ */
.watcher__k{font-family:var(--font-mono);font-size:var(--text-2xs);text-transform:uppercase;
  letter-spacing:var(--tracking-caps);color:var(--text-faint);margin-top:var(--space-sm)}
.watcher__v{font-size:var(--text-sm);margin-top:2px}
.spec{font-size:var(--text-xs);font-family:var(--font-mono);line-height:var(--leading-normal);
  background:var(--surface-sunken);border-radius:var(--radius-sm);padding:var(--space-sm);
  overflow-x:auto;white-space:pre;color:var(--text-muted);margin-top:var(--space-sm)}

/* ============================================================
   FAQ
   ============================================================ */
.faq{display:grid;gap:var(--space-md);grid-template-columns:repeat(auto-fill,minmax(340px,1fr))}
.faq h3{font-size:var(--text-md);margin-bottom:var(--space-xs)}

@media (max-width:600px){
  .shell{padding:0 var(--space-md) var(--space-2xl)}
  .topbar__in,.nav{padding-left:var(--space-md);padding-right:var(--space-md)}
  .viewhead h1{font-size:var(--text-2xl)}
  .card{padding:var(--space-md)}
  .topbar__meta{margin-left:0;width:100%;gap:var(--space-sm);flex-wrap:wrap}
}
@media print{ .topbar,.nav,.cmd button{position:static;display:none} }
`.trim();
