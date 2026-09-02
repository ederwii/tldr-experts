# Releasing tldr-experts

The rule is mechanical and enforced three times: by `scripts/release.sh` (does it), by the
Claude Code hook `scripts/release-gate-hook.sh` (denies `git tag` / `git push … vX.Y.Z` /
`npm publish` unless `scripts/release-check.sh` passes), and by `publish.yml`, which runs
`release-check.sh --ci` — the file checks (1–3) only, because 4 and 5 are local-path checks —
and re-runs typecheck, tests and build as its own steps.

## What a release is

A version is a **tag on main** (`vX.Y.Z`). The tag push triggers `.github/workflows/publish.yml`,
which runs typecheck, tests, build, `release-check.sh --ci`, verifies the tag equals
`package.json`, and publishes through npm **trusted publishing** (OIDC — no tokens, no OTP).
Package name `tldr-experts`; it installs the `tldrx` and `tldr-experts` commands.

## Before cutting one — what must be true (release-check.sh)

1. `package.json` and `plugin/.claude-plugin/plugin.json` carry the same version.
2. `CHANGELOG.md` has `## X.Y.Z — YYYY-MM-DD` (not "unreleased") listing what shipped and what
   did not; entries are facts, written from the merged commits, not intentions.
3. `README.md` release table has the row `| X.Y.Z | YYYY-MM-DD | \`alpha|beta|stable\` | … |`
   with the status tag chosen deliberately (definitions live under that table).
4. Working tree clean, on `main`, in sync with `origin/main`; tag not yet existing; version not
   on npm. When `release.sh` runs the gate the release commit is deliberately still local, so it
   passes `--pre-push` and "in sync" is asserted as **`origin/main` is HEAD's parent** — the same
   thing the check has always been for (nobody moved `main` under you, nothing but the release
   commit is unpushed), stated for a tree that has not pushed yet. Every other item is identical
   in both modes.
5. `bun run typecheck`, `bun test`, `bun run build` green; no `Bun.*` under `src/` outside
   `src/core/runtime/` (the grep scans `src` only). Items 4 and 5 run on the local path only —
   `--ci` skips them, and the seam check runs in no CI workflow.

## The order, and why it is this order

`release.sh` makes the mechanical edits, commits them **locally**, runs the gate, and pushes only
once the gate is green: commit → gate → push `main` → tag → push tag. Before 0.5.0 the push came
*before* the gate (#100), so any red item — tests, typecheck, build, the seam grep, "tag exists",
"already on npm" — left `origin/main` carrying a `release: X.Y.Z` commit with a dated CHANGELOG
heading and a dated README row and no tag: exactly the half-released state item 4 exists to
prevent, recoverable only by a revert commit on `main` or a hand-repaired CHANGELOG. Now a red
gate leaves `origin/main`, the tags and npm **untouched**, and the entire damage is one local
commit the script tells you how to drop (`git reset --hard HEAD~1`). `test/release-gate-order.test.ts`
holds that ordering against a sandbox origin.

## What to consider (judgement, not automated)

- **Semver for an alpha**: bump *minor* when a command, file schema or hook changes behaviour;
  *patch* for fixes only. Breaking a `version: 1` file schema is a *major* once we are `beta`.
- **Status tag**: `alpha` until file formats are frozen and two real workspaces have gone
  through Build; `beta` also needs an upgrade path documented; `stable` = 1.0. Releases through
  0.3.1 were `alpha`; 0.4.0 was the first `beta`, so a `version: 1` schema break is a *major* now.
- **Measured claims only** in CHANGELOG/README (costs, timings, limits): cite the run that
  measured them or say "not measured".
- **npm name constraints** (learned the hard way): unscoped `tldrx` is refused by npm's
  similarity rule; a full unpublish blocks the name for 24 h and burns the version numbers
  forever — never unpublish, deprecate instead.
- **After the tag**: watch `gh run list --workflow publish`; confirm `npm view tldr-experts version`;
  the npm-version and CI badges update on their own — the `status-…` badge is a hardcoded
  shields.io URL in `README.md` and must be moved by hand whenever the status tag changes. If the trusted publisher is missing, the run fails at
  the publish step — add it on npmjs.com (package → Settings → Trusted Publisher →
  GitHub Actions `ederwii/tldr-experts/publish.yml`) and re-run the workflow.

## How

```bash
# 1. make sure CHANGELOG has "## X.Y.Z — unreleased" and README has "| X.Y.Z | unreleased | `alpha` | … |"
scripts/release.sh X.Y.Z --tag alpha
```
That is the whole ceremony. The script refuses to run when the two lines above are missing.
