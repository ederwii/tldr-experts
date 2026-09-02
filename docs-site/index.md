---
layout: home

hero:
  name: tldr-experts
  text: An evidence-first AI development framework
  tagline: Five stages, a gate on every one, and every claim cited or refused. Runs from your terminal or from Claude Code.
  actions:
    - theme: brand
      text: Quickstart
      link: /quickstart
    - theme: alt
      text: Try it offline, free
      link: /quickstart#first-try-it-for-free
    - theme: alt
      text: GitHub
      link: https://github.com/ederwii/tldr-experts
features:
  - title: You decide, it records
    details: Each stage stops. You approve it, with a note. Who signed, when, and why goes into a file you can read six weeks later.
  - title: Claims carry sources
    details: A finding without a file, line, command or fact id behind it is refused before the stage can finish. No confident paragraphs about code nobody opened.
  - title: Money is measured, not guessed
    details: Every dollar reported comes from what the model actually charged. The one command that estimates says ESTIMATE in words.
  - title: The files are the state
    details: Everything lives in .tldrx/ and tldrx-work/ in your repo. Commit them and a teammate who clones gets the whole run.
---

<script setup>
// The version and maturity tag come from package.json and the README release table at
// build time (docs-site/version.ts), so this page cannot lag a release.
import { useData } from 'vitepress'
const { theme } = useData()
</script>

## What it is

You ask an AI to build something. It goes away, does a lot, and comes back with a summary
you have to take on faith. Later you cannot tell what it read, what it assumed, what it
cost, or who agreed to any of it.

tldrx puts a shape around that. Work is broken into five stages — **What → How → Plan →
Build → Watch** — and each one ends at a **gate**. A gate is a stop: nothing after it runs
until it is signed. Some gates you sign; some the tool may sign for itself, but only when
it can show its work.

Everything a stage produces is a file in your repo — the intent, the design, the plan, the
questions it could not answer, the answers you gave, the money spent. Those files are not
a report about the state. They **are** the state: the tool re-reads them to decide what to
do next. The canonical state is on disk — inspectable, diffable, committable, recoverable.

## How it feels

::: info 1 — Open a piece of work
`tldrx run new payments --scope feature --budget 25` writes a folder. Nothing has run yet
and nothing has been spent.
:::

::: info 2 — Run one stage
`tldrx next` runs the stage the cursor is on, writes its files, and stops at the gate with
exit code `4` — "the work is done, the decision is yours."
:::

::: info 3 — Sign it, or send it back
`tldrx approve --note "why"` re-runs the stage's checks against what is on disk and moves
the cursor on. `tldrx reject --note "…"` sends it back, and the next attempt reads your note.
:::

Repeat until the run is finished. `tldrx run auto` does the repeating for you and stops the
first time something genuinely needs a person.

## Where this is

**{{ theme.tldrxStatus }}, version {{ theme.tldrxVersion }}.** Every command is real and tested — the docs on this site were
written by running them — and `tldrx --help` on your machine is the authority, not this
site.

The bar for **beta** was public and it has been cleared: file formats frozen (`version: 1`
schemas only grow), two or more real workspaces taken through the Build phase, and a
documented upgrade path. Releases through 0.3.1 were `alpha`; 0.4.0 was the first `beta`.
**Stable** means 1.0 and semver from then on.

Install name is `tldr-experts`; it gives you two commands, `tldrx` (short) and
`tldr-experts` (the same binary).
