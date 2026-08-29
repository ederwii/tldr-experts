/**
 * A workspace whose `docs/` folder exercises every fact the inventory reports:
 * cross-links both ways (a Markdown link and a bare filename), an ADR with a
 * `Status:` line, open markers, and one document that cites eight paths which
 * really exist under the declared repo — the only way `code-derived: likely` can
 * fire, since the heuristic resolves every path before counting it.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../../../src/core/paths.ts";

export const FAKE_TRIAGE_IMPL = join(FRAMEWORK_ROOT, "test", "fixtures", "seed", "fakeTriage.ts");

/** The eight files `03-legacy-inventory.md` cites, all real under `api/`. */
export const CODE_FILES: readonly string[] = [
  "src/Billing/Money.cs",
  "src/Billing/Invoice.cs",
  "src/Billing/Ledger.cs",
  "src/Tenancy/Account.cs",
  "src/Tenancy/Location.cs",
  "src/Catalog/Menu.cs",
  "src/Catalog/Item.cs",
  "src/Ordering/Order.cs",
];

export const OVERVIEW_MD = [
  "# Overview",
  "",
  "## Goal",
  "Rebuild the domain. Start at [tenancy](01-tenancy.md), then money.",
  "",
  "## Open questions",
  "TODO decide the currency rounding rule.",
  "TBD whether locations can be nested.",
  "",
].join("\n");

export const TENANCY_MD = [
  "# Tenancy",
  "**Status:** Accepted",
  "",
  "## Accounts",
  "An account is the commercial boundary.",
  "",
  "## Locations",
  "A location owns physical operations.",
  "",
].join("\n");

export const BILLING_MD = [
  "# Billing",
  "",
  "## Money",
  "Prices are integers in minor units. Depends on what 02-billing.md's sibling",
  "01-tenancy.md decided about accounts.",
  "",
  "## Open question",
  "Do we support partial refunds??",
  "",
].join("\n");

export const LEGACY_MD = [
  "# Legacy inventory",
  "",
  "## What exists today",
  ...CODE_FILES.map((path) => `- \`${path}\` — still in use`),
  "",
  "This is a transcription of the code, not a decision about it.",
  "",
].join("\n");

export const ADR_MD = [
  "# ADR-001 — Single currency",
  "**Status:** Superseded",
  "",
  "We decided one currency per account. Replaced by 02-billing.md.",
  "",
].join("\n");

export const WORKSPACE_YML = `version: 1
mode: single-repo
root_is_repo: true
root: .
detected_at: 2026-08-30T09:00:00Z
detected_by: "tldrx test"
repos:
  - name: api
    path: api
    default_branch: main
    stack: [dotnet]
    package_manager: nuget
    commands: {build: "true", test: "true", lint: null, typecheck: null, run: null}
    ci: []
    confidence: high
`;

export interface SeedWorkspace {
  readonly root: string;
  /** Directory holding the fake `claude`; put it first on PATH. */
  readonly binDir: string;
  readonly dispose: () => void;
}

export interface SeedWorkspaceOptions {
  /** Appended to `.tldrx/workspace.yml` — e.g. a `seed_triage:` block. */
  readonly workspaceExtra?: string;
  /** Extra files, keyed by path relative to the root. */
  readonly files?: Readonly<Record<string, string>>;
}

export function makeSeedWorkspace(options: SeedWorkspaceOptions = {}): SeedWorkspace {
  const root = mkdtempSync(join(tmpdir(), "tldrx-seed-"));
  write(root, ".tldrx/workspace.yml", WORKSPACE_YML + (options.workspaceExtra ?? ""));
  write(root, ".tldrx/memory/facts.yml", "version: 1\nfacts: []\n");
  for (const path of CODE_FILES) write(root, `api/${path}`, "// fixture\n");

  write(root, "docs/00-overview.md", OVERVIEW_MD);
  write(root, "docs/01-tenancy.md", TENANCY_MD);
  write(root, "docs/02-billing.md", BILLING_MD);
  write(root, "docs/03-legacy-inventory.md", LEGACY_MD);
  write(root, "docs/adr/ADR-001.md", ADR_MD);
  for (const [rel, content] of Object.entries(options.files ?? {})) write(root, rel, content);

  const binDir = join(root, ".fakebin");
  mkdirSync(binDir, { recursive: true });
  const claude = join(binDir, "claude");
  // Absolute paths: the tests put ONLY this directory on PATH, so a fake that
  // failed to resolve could never fall through to the real binary and spend money.
  writeFileSync(
    claude,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_TRIAGE_IMPL)} "$@"\n`,
    "utf8",
  );
  chmodSync(claude, 0o755);

  return { root, binDir, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** A proposal the validator accepts against this fixture — the happy-path baseline. */
export function goodProposal(): Record<string, unknown> {
  return {
    shared_context: ["docs/00-overview.md"],
    exclude: [
      { path: "docs/03-legacy-inventory.md", reason: "code-derived: the model can read api/src instead" },
      { path: "docs/adr/ADR-001.md", reason: "status: superseded" },
    ],
    runs: [
      {
        slug: "billing",
        scope: "feature",
        goal: "Money, prices and refunds",
        seeds: ["docs/02-billing.md"],
        depends_on: ["tenancy"],
        size: "M",
        budget_usd: 25,
        why: [{ claim: "Money is its own aggregate", src: "seed:docs/02-billing.md#Money" }],
      },
      {
        slug: "tenancy",
        scope: "feature",
        goal: "Accounts and locations",
        seeds: ["docs/01-tenancy.md"],
        depends_on: [],
        size: "S",
        budget_usd: 12,
        why: [{ claim: "Accounts bound everything else", src: "seed:docs/01-tenancy.md:5" }],
      },
    ],
    questions: [
      { id: "Q1", text: "Which currency rounding rule?", options: ["banker's", "half-up"] },
    ],
  };
}

function write(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}
