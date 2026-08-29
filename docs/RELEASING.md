# Releasing tldr-experts

The rule is mechanical and enforced three times: by `scripts/release.sh` (does it), by the
Claude Code hook `scripts/release-gate-hook.sh` (denies `git tag` / `git push … vX.Y.Z` /
`npm publish` unless `scripts/release-check.sh` passes), and by `publish.yml` (runs the same
check with `--ci` before publishing).

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
   on npm.
5. `bun run typecheck`, `bun test`, `bun run build` green; no `Bun.*` outside `src/core/runtime/`.

## What to consider (judgement, not automated)

- **Semver for an alpha**: bump *minor* when a command, file schema or hook changes behaviour;
  *patch* for fixes only. Breaking a `version: 1` file schema is a *major* once we are `beta`.
- **Status tag**: stays `alpha` until file formats are frozen and two real workspaces have gone
  through Build; `beta` needs an upgrade path documented; `stable` = 1.0.
- **Measured claims only** in CHANGELOG/README (costs, timings, limits): cite the run that
  measured them or say "not measured".
- **npm name constraints** (learned the hard way): unscoped `tldrx` is refused by npm's
  similarity rule; a full unpublish blocks the name for 24 h and burns the version numbers
  forever — never unpublish, deprecate instead.
- **After the tag**: watch `gh run list --workflow publish`; confirm `npm view tldr-experts version`;
  the README badge updates on its own. If the trusted publisher is missing, the run fails at
  the publish step — add it on npmjs.com (package → Settings → Trusted Publisher →
  GitHub Actions `ederwii/tldr-experts/publish.yml`) and re-run the workflow.

## How

```bash
# 1. make sure CHANGELOG has "## X.Y.Z — unreleased" and README has "| X.Y.Z | unreleased | `alpha` | … |"
scripts/release.sh X.Y.Z --tag alpha
```
That is the whole ceremony. The script refuses to run when the two lines above are missing.
