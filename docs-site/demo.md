---
title: Live demo
---

<script setup>
import { withBase } from 'vitepress'
</script>

# Live demo

Below is a real `tldrx dashboard --static` page. Not a screenshot, not a mock-up: the
export is generated on every deploy of this site by the same model builder and the same
renderer the command in your terminal uses, so what you are looking at is what today's
`tldrx` draws.

::: warning Every number on it is invented
The workspace behind this page does not exist. It is composed from the synthetic fixtures
in the framework's own test suite — eight runs called things like *Player scoreboard* and
*Migrate the ledger*, two invented experts, invented dollars, invented signatures. No real
project, client or repository appears anywhere in it, and the generator physically refuses
to read from anywhere but `test/fixtures/`.
:::

<p>
  <a :href="withBase('/dashboard-demo/index.html')" target="_blank" rel="noreferrer"><strong>Open the demo full screen →</strong></a>
</p>

<iframe
  :src="withBase('/dashboard-demo/index.html')"
  title="tldrx dashboard — demo"
  loading="lazy"
  style="width:100%;height:80vh;border:1px solid var(--vp-c-divider);border-radius:8px;background:#FFFDF8"
></iframe>

## What to look at

| On the page | What it is showing you |
|---|---|
| The runs list | Eight runs at once, and the four states that mean **a person is blocking**: an open question, a pending gate, a failed stage, a bundle waiting to be run. The one you could pick up next wears `← next`. |
| `260901-scoreboard` | Open it. The execution path stage by stage — expert, model, cost, who signed the gate and when — plus the handoff it wrote and the questions it could not answer for itself. |
| `260903-delta` | A run stopped on a question. This is the shape of the thing: the tool does not guess a retention window, it stops and asks. |
| `260903-bravo`, `260903-golf` | Runs that are not blocked on a person at all — they are waiting on another run to finish first. |
| Experts | Two competency profiles, with levels **recomputed from the evidence at read time** rather than read off disk, and the evidence rows behind each one. |

Everything on it came out of files. There is no database and no server behind the numbers —
[the files are the state](/concepts/files-as-state), and the dashboard is one read of them.

## Try it on your own workspace

```bash
tldrx dashboard              # a live server on 127.0.0.1, redrawing as files change
tldrx dashboard --static     # write one self-contained index.html and stop
```

The static export is a single file with the CSS, the JavaScript and the data inlined. It
fetches nothing — which is why it can be dropped onto a static site like this one, and why
it leaks nothing about whoever opens it. See [the dashboard reference](/reference/dashboard)
for what each view holds and what the page deliberately does **not** do.

## How this page stays true

It is regenerated from scratch on every documentation deploy, by
`docs-site/scripts/gen-demo.ts`, and the workflow that deploys the site also runs when the
dashboard's own source or the fixtures behind it change. A demo that is rebuilt cannot
quietly become a picture of a version that no longer exists — and the test suite holds the
rest: that the page is self-contained, that it names no path from the machine that built it,
and that stripping the one banner leaves bytes identical to what the CLI writes.
