# Stack packs — design

Status: approved by the owner on 2026-09-05 (brainstorm in session). Implementation follows
`docs/superpowers/plans/2026-09-05-stack-packs-plan.md`.

## 1. Problem

Role experts (product, architect, delivery, developer, operations) are workflow-specialised and
technology-generic: they encode the evidence discipline and the stage handoffs and carry zero
stack content. Stack experts are name-only stubs — the language name is the only stack-specific
token in the generated body (`src/core/init/renderExpert.ts`). The repo's own audit scored the
experts' knowledge 6/10. Detection knows four frameworks (react, vite, expo, next) and never reads
a project's `AGENTS.md`, `CLAUDE.md`, or its installed agent skills.

Result: on a real workspace the developer builds from the model's habits and the reviewer has no
stack checklist to hold the story against.

## 2. Decisions (owner-approved)

1. **Interrogative by default, prescriptive only where the project is silent.** Measured repo
   conventions win over pack content, always. Packs carry two sections: *Defaults* (apply only
   when the repo has no signal on the topic; each default names the signal that overrides it) and
   *Checks* (always asked in review; a miss is a finding with a cited file; the project's own
   convention is the accepted answer when it exists).
2. **Two layers**: a language pack (typescript, javascript, python, dotnet) and framework
   overlays detected from manifests. "General backend / frontend practice" lives inside the
   overlays, not in a third layer.
3. **Overlays are detected from manifests, never inferred from the language.** Two .NET
   workspaces can use opposite architectures (minimal APIs vs controllers + CQRS); a single
   prescriptive ".NET pack" would be wrong for one of them.
4. **One per-project switch**; under it every overlay detection can prove is on, each with its
   evidence line written to `workspace.yml`. Off by default.
5. **Packs live inside the existing stack expert** (option 1 of three considered): the pack body
   replaces the stub body of `<lang>-stack`; overlays are framework-managed files under the
   expert folder. No new prompt mechanism, no schema bump.
6. **Skills for doing, packs for checking, both on.** Project skills (`.claude/skills/*/SKILL.md`)
   are detected and *named* to the developer; the harness loads and invokes them. Packs are
   provider-independent and reach the reviewer; skills do not replace them. The pack never yields
   except its Defaults, which already yield to any project signal — a present skill counts as one.
7. Private workspaces used as evidence during design are never named in this repo.

## 3. Measured constraints that shape the mechanism

- `loadExpertBundles` renders an expert `body`; the Build developer prompt renders **body only**
  (`src/core/build/prompts.ts` `experts: {name, body}[]`), never `knowledge/`. So overlays cannot
  live in `knowledge/` if they are to reach the developer.
- The Build **reviewer prompt has no expert content at all** (`buildReviewerPrompt` has no
  experts field). Checks must be added to it explicitly.
- `knowledge/` is a flat `*.md` listing, `.rejected.md` excluded, 48 KiB total budget split
  harmonically, H2-boundary truncation (`src/core/experts/expertKnowledge.ts`). Trained knowledge
  must not be crowded out by pack content — separate budget.
- `workspace.yml` is regenerated on every `tldrx init` (`log.overwrite`) and its validator is
  passthrough for unknown keys. New fields are additive; the switch must survive a re-init.
- Stack experts are seeded only for `LANGUAGES = typescript|javascript|dotnet|python|go|rust`
  (`src/core/init/planExperts.ts`); frameworks become competency areas. The load-time mapping
  requests `<anything>-stack` and `selectExperts` silently skips absent ones — out of scope here,
  filed as an issue.
- .NET detection is existence-only (`.sln`/`.csproj`), `pyproject.toml` is existence-only,
  `Directory.Packages.props` is never read. Overlay detection needs its own manifest readers.
- `spawnAgent` passes `--allowedTools` without `Skill`; Build runs in a worktree that carries
  tracked files only, so untracked skills do not exist there.

## 4. Design

### 4.1 Files (templates shipped in the package)

```
templates/experts/stack/
  typescript.md  javascript.md  python.md  dotnet.md          # language pack bodies
  overlays/
    react.md  next-app-router.md  vite-react-spa.md  expo-router.md  node-express.md  prisma.md
    aspnet-minimal-apis.md  aspnet-controllers.md  mediatr-cqrs.md  efcore-npgsql.md
    fastapi.md  sqlalchemy-alembic.md  postgres-testcontainers.md
```

Every file: `# <title>`, one paragraph of scope, `## Defaults (when the repo is silent)`,
`## Checks (always asked in review)`. Each default is a bullet ending in
`— overridden by: <signal>`. Each check is a bullet with a `verify:` hint naming what to open or
run. Version-agnostic wording unless a version is a detection output. Size caps enforced by a
shape test: body ≤ 8 KiB, overlay ≤ 6 KiB. No absolute paths, no workspace names.

### 4.2 Materialised per project

```
.tldrx/experts/<lang>-stack/
  expert.md                      # pack body (front matter preserved from the stub)
  overlays/<overlay-id>.md       # framework-managed: rewritten on every enable / re-init
  knowledge/                     # untouched — trained knowledge stays exactly as it is
```

Body replacement rule: the pack body replaces `expert.md`'s body only when the current body is
byte-identical to what `renderExpert` would generate for that expert today (i.e. untouched
stub). Otherwise the body is left alone and the command prints
`kept: <expert> body was edited — pack body not applied (delete the body to re-seed)`. Front
matter is preserved and gains `pack: <lang>@<templates-hash>` when applied.

### 4.3 `workspace.yml` (additive, `version: 1` unchanged)

```yaml
stack_packs:
  enabled: true            # the one switch; carried forward across re-init
  enabled_at: <iso>
repos:
  - name: api
    overlays:              # always detected, evidence-only; enabled gates materialisation
      - id: aspnet-controllers
        evidence: "src/Api/Controllers/ (directory present)"
      - id: mediatr-cqrs
        evidence: "Directory.Packages.props: PackageVersion Include=\"MediatR\""
    skills:                # always detected
      - name: impeccable
        description: "Use when the user wants to design…"
        path: .claude/skills/impeccable/SKILL.md
        tracked: false
```

Detection runs inside `detectWorkspace` so a re-init refreshes both lists. `stack_packs` is read
from the existing file and carried forward by the writer.

### 4.4 Overlay detection table (one module: `src/core/detect/overlays.ts`)

Each rule: `id`, `applies(manifests) → evidence | null`. Rules read only what the table names.

| id | fires when | evidence string |
|---|---|---|
| react | package.json dep `react` | `package.json: dependencies.react` |
| next-app-router | dep `next` and `app/` or `src/app/` dir | `package.json: dependencies.next; app/ present` |
| vite-react-spa | deps `vite` and `react`, no `next` | `package.json: devDependencies.vite + dependencies.react` |
| expo-router | dep `expo-router` or `expo` | `package.json: dependencies.expo-router` |
| node-express | dep `express` | `package.json: dependencies.express` |
| prisma | dep `prisma` or `@prisma/client` | `package.json: …` |
| aspnet-minimal-apis | a `Microsoft.NET.Sdk.Web` csproj and no `Controllers/` dir under it | `<csproj>: Sdk=Web; no Controllers/` |
| aspnet-controllers | a `Microsoft.NET.Sdk.Web` csproj with a `Controllers/` dir | `<csproj>: Sdk=Web; Controllers/ present` |
| mediatr-cqrs | `MediatR` in any csproj `PackageReference` or `Directory.Packages.props` `PackageVersion` | `<file>: Include="MediatR"` |
| efcore-npgsql | `Microsoft.EntityFrameworkCore*` and `Npgsql*` packages | `<file>: Include="Npgsql…"` |
| fastapi | `fastapi` in pyproject `[project] dependencies` or requirements*.txt | `pyproject.toml: dependencies fastapi` |
| sqlalchemy-alembic | `sqlalchemy` (alembic optional, noted) | `pyproject.toml: dependencies sqlalchemy` |
| postgres-testcontainers | a Postgres driver (`Npgsql`, `pg`, `@prisma/adapter-pg`, `asyncpg`, `psycopg`) **and** a Testcontainers package | `<file>: <driver> + <testcontainers>` |

Manifest readers: package.json via JSON; csproj / `Directory.Packages.props` via a regex over
`Include="…"` and `Sdk="…"` (no XML parser dependency); pyproject via a regex over the
`[project] dependencies` array and `requirements*.txt` lines. Names are lower-cased before
matching. Unknown → no overlay, never a guess.

### 4.5 Prompt path (one derivation)

- `loadExpertBundles` gains, for `kind: stack` experts when `stack_packs.enabled`, the
  concatenation `body + overlays/*.md` (sorted by id) into the bundle's `body`, capped at
  `PACK_MAX_BYTES = 24 KiB` with the existing `truncateAtHeading` (exported, not copied) and a
  `(not inlined: <n> overlays)` marker. Because every renderer already prints `body`, stage
  prompts and the Build developer prompt get packs with no further change.
- **Reviewer**: `buildReviewerPrompt` gains `stackChecks: string | null` — the `## Checks`
  sections of the repo's active pack body and overlays, extracted by one helper
  (`src/core/experts/packSections.ts`), under `## Stack checks (the repo's own conventions win)`.
  Same helper feeds `tldrx expert packs status`.
- **Project skills**: a framework-computed section `## Project skills` (precedent: `## Dispatch
  notes`) listing `name — description`, plus `untracked: not present in story worktrees` where
  applicable. Rendered in stage prompts (`renderParts`) and in the developer prompt. When any
  skill is detected, developer turns add `Skill` to `--allowedTools`. Untracked skills also
  produce a one-line warning at Build start.
- Disabled switch → bodies render as today, no overlays, no checks section. Skills section is
  independent of the switch.

### 4.6 CLI: `tldrx expert packs <enable|disable|status>`

- `enable`: sets the switch, re-runs detection, seeds any missing `<lang>-stack` expert through
  the existing seeding path, applies pack bodies per §4.2, writes `overlays/*.md`, prints one
  line per repo: overlays (with evidence) and skills (with tracked flag), and every `kept:` line.
- `disable`: clears the switch, deletes `overlays/` folders (regenerable), leaves bodies and
  knowledge untouched and says so.
- `status`: prints switch state, per-repo overlays + evidence, skills, and each stack expert's
  body state: `pack@<hash>` / `stub` / `edited`. Exit 0 always; `enable` exits 1 on no
  detectable language (usage family).
- Help text in `src/cli/helpText.ts` is the authoritative surface; docs quote it.

### 4.7 Non-goals (this change)

- Ingesting `AGENTS.md` / `CLAUDE.md` content as stage inputs — its own bounded change; issue
  filed with the measured negative.
- Third-party skill import into `knowledge/`; Codex skill discovery (unverified in `codex --help`).
- Fixing the `<framework>-stack` load-time naming drift (issue filed).
- Go / Rust packs (no overlay evidence to write against).

## 5. Testing (red-first)

- `test/detect-overlays.test.ts`: every rule fires on a synthetic manifest and stays silent on
  its negative; evidence strings match the table; lower-casing; `Directory.Packages.props`
  honoured; pyproject and requirements both honoured.
- `test/detect-skills.test.ts`: tracked vs untracked (real `git init`, private `$TMPDIR`,
  machine-load guard row); frontmatter name/description parsed; missing dir → empty list.
- `test/stack-packs.test.ts`: enable/disable/status round trip on a fixture workspace; body
  replaced only when stub-identical (mutate the body → `kept:`); overlays rewritten on second
  enable; disable removes overlays only; `stack_packs` survives a re-init; front matter `pack:`.
- `test/pack-templates.test.ts`: every template has both H2s, obeys size caps, defaults end with
  `— overridden by:`, no `/Users/` or `C:\` paths; every overlay id in the detection table has a
  template and vice versa (one derivation).
- Prompt tests: stage prompt and developer prompt contain the overlay heading when enabled and
  not when disabled; reviewer prompt contains `## Stack checks` only when enabled; `## Project
  skills` present when a skill exists; `--allowedTools` argv pin includes `Skill` only then.
- `test/schemas.test.ts`: `version: 1` unchanged; old `workspace.yml` without the new keys loads.
- Shape/public-surface tests updated where they enumerate commands or workspace fields.

## 6. Docs (EN and ES in lockstep)

CHANGELOG (why, not what) · README status · `docs/spec.md` §2.1 (workspace fields) and the
`expert packs` command · `docs/ROADMAP.md` ("Stack expertise shared by every expert" → shipped
as opt-in packs) · `docs/guide/04-experts.md` · docs-site `guides/experts.md`, `reference/cli.md`,
`concepts/files-as-state.md`, `quickstart.md` (one line on the switch) — and their `es/` twins.
