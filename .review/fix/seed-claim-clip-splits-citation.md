verdict: merge
reviewed-by: a separate sonnet reviewer sub-agent (it did not write the code); finding 2's downstream question re-checked by tldr-experts-6d, Claude Opus 5
against: cf63797

## What this fixes

A seed bullet over `MAX_CLAIM_CHARS` was clipped mid-`[src:]`; the renderer then
appended its own `]`, and `parseFileSrc` — which splits at `lastIndexOf(":")` —
folded the two citations into one path that never existed, so `run new` refused
naming a file nobody could find. It cost three real seeds in one day, written for
live runs.

Both halves are fixed, and they are separate bugs wearing one issue number: the
clip no longer splits a citation, and the refusal no longer invents a path.

## §7, the risk this fix was most likely to create

The `[src:]` grammar lives in exactly one file. A clipper that learned to recognise
a citation by itself would have been a second grammar — the failure mode the shape
tests exist for. It did not: `unclosedSrcMarker` and `foldsUnclosedSrcMarker` are new
leaves in `src/core/text/srcToken.ts`, and both `markdownClaims.ts` and `newRun.ts`
import them. The reviewer confirmed by grep that the tree still holds exactly ONE
`lastIndexOf(":")`, the pre-existing one in `parseFileSrc`, untouched.

## Measured, not asserted

- **Mutations, run**: reverting the clip to the old one-liner reddens exactly one test;
  stripping the refusal's note reddens exactly the other. Each half fails alone; tree
  clean after each restore.
- **The tests can fail for the right reason**: `src-grammar` asserts index positions
  from realistic input rather than the marker constant that produced them, and
  `greenfield` reads the actual handoff file content (§8).
- **No golden moved.**
- **The dated section is untouched**: `## 0.18.2` is byte-identical to
  `d4282aa:CHANGELOG.md`; the bullet went under a new `## 0.18.3 — unreleased`. No
  README release-table row was added, which is right — the release commit adds that,
  and a 0.18.3 row now would drift from `package.json` at 0.18.2 and redden the
  public-surface guard.
- **Docs in lockstep**: `docs/guide/05-seeds-and-triage.md` and both
  `docs-site/{,es/}guides/unattended-operation.md` — pages a peer session wrote hours
  ago naming #275 as a LIVE trap — now describe it as fixed and add the "close your own
  `[src:]`" guidance. A whole-tree grep found no surviving prose calling it live. That
  matters as much here as the code: a shipped document describing a fixed bug as live
  is the same §7 lie in prose, and this repo shipped one earlier today.

## The one finding worth writing down, and why it is not blocking

A bullet that is ENTIRELY a citation cannot be cut back to the citation's start without
becoming empty, so `clean()` returns it whole — over the cap, unclipped. An empty claim
that passes validation would be worse than a refusal, so returning it is the right
choice; the question is whether anything downstream then refuses it for being long.

The reviewer said nothing does. I checked that myself rather than take it, because the
whole bug being fixed here IS a refusal firing on length: `MAX_CLAIM_CHARS` appears only
in `markdownClaims.ts` and in tests — no importer, no validator, no renderer asserts it.
So the overrun is real, named in a comment at the cut, and inert. If a length assertion
is ever added downstream, this is the case that will find it.

## Not verified

No CI — nothing merged yet. The shared checkout was never written to by the implementer
while a release was being cut in it; only `git fetch`, `worktree add` and read-only
`cat-file`.
