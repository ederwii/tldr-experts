<!-- schema: 1 -->
<!-- Written by the Interview step. The questions FILE is the contract, not the
     channel — terminal today, a chat bridge later, same file either way.

     THE SHAPE BELOW IS THE PARSER'S, NOT A SUGGESTION. `tldrx` reads a question
     block with one regex — `^## (Q\d+) · (.+)$` — and a heading that misses it is
     not half-read, it is read as ABSENT. Measured 2026-08-29: this template used
     to teach `### Q1 — …` and `**Answer:**`, a stage copied it faithfully, the
     parser found zero questions, and the auto gate recorded "0 open" and signed
     itself over four unanswered ones.

     Copy the Q1 block verbatim and change the words, not the punctuation. The
     `·` is U+00B7 MIDDLE DOT. Run `tldrx questions lint` to check, and
     `tldrx questions lint --fix` to convert a file already written the wrong way. -->

# Questions — `<run-id>` / `<phase>`

**Before this file was written**, `.tldrx/memory/facts.yml` was searched for every
subject below. Nothing here is already known. If you find otherwise, that is a bug
in the framework — say so and it gets fixed.

You may answer any subset. Unanswered questions become **assumed** decisions in the
handoff, marked as such, and the run continues.

## Q1 · Where does leaderboard state live?
<!-- id: Q1 | status: open | area: data-model | asked_by: architect | asked_at: 2026-08-29T14:02:11Z -->
Why asked: no ranking store exists in the map [src: absent:.tldrx/map/api/domains.md]

- A) New Postgres table, recomputed on hunt completion
- B) Redis sorted set, rebuilt nightly
- C) other — write it below

[Answer]:

## Q2 · <the next question, in one sentence>
<!-- id: Q2 | status: open | area: <one word> | asked_by: <expert> | asked_at: <RFC3339 UTC> -->
Why asked: <what is blocked without it, concretely> [src: <a real citation>]

- A) <option>
- B) <option>

[Answer]:

<!--
  Every element is required (spec §2.7):

  Heading         `## Qn · <title>` — `##`, one space, the id, ` · `, the question
  Metadata        one HTML comment, pipe-separated, all five keys, on the line under the heading
                  status ∈ open | answered | withdrawn
  Why asked       one line, and it must END with a `[src: …]` token — that is what
                  proves the gap is real rather than assumed
  Options         2–5 bullets, `- A)` `- B)` … lettered in order; the last may be free text
  Answer slot     exactly one `[Answer]:` line, on its own line, left empty

  Ids ascend and are unique; a block is at most 40 lines.

  You write the `[Answer]:` text and nothing else. The hook flips `status:` to
  `answered`, appends the `<!-- answered_by: … | answered_at: … | fact: F0nn -->`
  footer, records the fact and appends the event. Do not write the footer by hand.

  Answers are captured to `.tldrx/memory/facts.yml` with provenance — who, when,
  which run, which question id — and are reused by every later run.
-->
