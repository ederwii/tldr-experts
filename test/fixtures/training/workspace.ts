/**
 * A workspace built for the training tests: two repos with real source files, an
 * expert with two areas, a map, a past run and a fact.
 *
 * The source files are REAL because every citation a training run produces is
 * resolved against the filesystem — `api:src/auth/oauth.ts:3` only validates if
 * that file exists and has at least three lines. A fixture of empty stubs would
 * make the tests pass by making the check meaningless.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../../../src/core/paths.ts";

export const FAKE_TRAIN_IMPL = join(FRAMEWORK_ROOT, "test", "fixtures", "training", "fakeClaude.ts");

export const TRAIN_NOW = new Date("2026-09-01T12:00:00Z");
export const TRAIN_AT = "2026-09-01T12:00:00Z";

export const EXPERT = "auth-expert";
export const AREA = "oauth";

const WORKSPACE_YML = `version: 1
mode: multi-repo
root_is_repo: true
detected_at: 2026-08-28T14:02:11Z
detected_by: "tldrx 0.2.0"
repos:
  - name: api
    path: api
    default_branch: main
    stack: [typescript]
    package_manager: npm
    commands: {build: "true", test: "true", lint: null, typecheck: null, run: null}
    ci: []
    confidence: high
  - name: lab
    path: lab
    default_branch: main
    stack: [typescript]
    package_manager: npm
    commands: {build: "true", test: "true", lint: null, typecheck: null, run: null}
    ci: []
    confidence: high
`;

const OAUTH_TS = `// OAuth authorisation-code exchange.
import { store } from "./token.ts";

export const OAUTH_SCOPES = ["openid", "profile"];

export async function exchange(code: string): Promise<string> {
  if (code === "") throw new Error("an oauth code is required");
  const token = await post("/oauth/token", { code });
  store.put(token);
  return token;
}

async function post(path: string, body: unknown): Promise<string> {
  return JSON.stringify({ path, body });
}
`;

const TOKEN_TS = `// Token storage for the oauth flow.
const held = new Map<string, string>();

export const store = {
  put(token: string): void {
    held.set("access", token);
  },
  get(): string | undefined {
    return held.get("access");
  },
};
`;

const HUNTS_TS = `export function nextStop(): string {
  return "unrelated to auth";
}
`;

const DOMAINS_MD = `# Domains — api

> Top-level source folders — candidates for a domain, not confirmed boundaries.
> Provider: \`static\`. Written by \`tldrx map\`; edits are overwritten on refresh.

- \`src/auth/\` — 2 source files [src: api:src/auth/oauth.ts:1]
- \`src/hunts/\` — 1 source file [src: api:src/hunts/next.ts:1]
`;

export const EXPERT_MD = `---
name: ${EXPERT}
kind: domain
status: created
created_by: "tldrx init"
created_at: 2026-08-28T14:02:11Z
repos: [api]
---

# ${EXPERT}

## Role

Speaks for the \`src/auth/\` area of api.

## What to cite

- Files in this expert's domain, as \`repo:path:line\`
`;

export const COMPETENCIES_YML = `# Written by \`tldrx init\` (spec §2.6). \`level\` is computed, never hand-set.
version: 1
expert: ${EXPERT}
status: created
last_trained: null
areas:
  - id: ${AREA}
    title: OAuth authorisation code exchange
    level: 0
    train_prompt: tldrx expert train ${EXPERT} --area ${AREA} --mode light
    evidence: []
  - id: sessions
    title: session handling
    level: 0
    train_prompt: tldrx expert train ${EXPERT} --area sessions --mode light
    evidence: []
`;

const RUN_YML = `version: 1
id: 260820-oauth
title: "OAuth clean-up"
scope: feature
status: done
repos: [api]
created_at: 2026-08-20T09:00:00Z
`;

const RUN_HANDOFF = `# Handoff — 02-how / contracts — run 260820-oauth
Stage: contracts · Expert: architect · Model: sonnet · Cost: $1.10 of $3.00 ceiling · 2026-08-20T11:00:00Z

## Findings
- The oauth exchange already stores the token centrally [src: api:src/auth/oauth.ts:9]

## Decisions
- Token storage stays in-process; no new store [src: api:src/auth/token.ts:2]

## Unknowns
- none [src: absent:.tldrx/memory/facts.yml]

## Evidence ledger
- The api builds clean [src: $ true → exit 0]
`;

const RUN_RETRO = `# Retro — run 260820-oauth

## What worked
- Reading the token store before the exchange [src: api:src/auth/token.ts:4]

## What to change
- none [src: absent:tldrx-work/260820-oauth]
`;

export const FACTS_YML = `version: 1
facts:
  - id: F001
    fact: "OAuth scopes are fixed at openid and profile"
    area: oauth
    repos: [api]
    kind: answer
    confidence: measured
    source: {who: alan, when: 2026-08-20, run: 260820-oauth, q: Q1}
    supersedes: null
    superseded_by: null
    retired: null
  - id: F002
    fact: "Deploys are manual"
    area: deploy
    repos: [lab]
    kind: answer
    confidence: stated
    source: {who: alan, when: 2026-08-01, run: null, q: null}
    supersedes: null
    superseded_by: null
    retired: null
`;

export interface TrainingWorkspace {
  readonly root: string;
  readonly expertDir: string;
  readonly binDir: string;
  readonly statePath: string;
  readonly dispose: () => void;
}

export interface TrainingWorkspaceOptions {
  /** Extra or replacement files, keyed by path relative to the root. */
  readonly files?: Readonly<Record<string, string>>;
  /** Omit the past run and its handoff/retro — full mode then has nothing to mine. */
  readonly withoutRuns?: boolean;
}

export function makeTrainingWorkspace(options: TrainingWorkspaceOptions = {}): TrainingWorkspace {
  const root = mkdtempSync(join(tmpdir(), "tldrx-train-"));
  const files: Record<string, string> = {
    ".tldrx/workspace.yml": WORKSPACE_YML,
    ".tldrx/memory/facts.yml": FACTS_YML,
    ".tldrx/conventions/shared.md": "# Shared conventions\n\n- Done means proven.\n",
    ".tldrx/map/api/domains.md": DOMAINS_MD,
    [`.tldrx/experts/${EXPERT}/expert.md`]: EXPERT_MD,
    [`.tldrx/experts/${EXPERT}/competencies.yml`]: COMPETENCIES_YML,
    "api/src/auth/oauth.ts": OAUTH_TS,
    "api/src/auth/token.ts": TOKEN_TS,
    "api/src/hunts/next.ts": HUNTS_TS,
    "lab/src/app.ts": "export const app = 1;\n",
  };
  if (options.withoutRuns !== true) {
    files["tldrx-work/260820-oauth/run.yml"] = RUN_YML;
    files["tldrx-work/260820-oauth/02-how/handoff.md"] = RUN_HANDOFF;
    files["tldrx-work/260820-oauth/retro.md"] = RUN_RETRO;
  }
  for (const [rel, content] of Object.entries({ ...files, ...(options.files ?? {}) })) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }

  const binDir = join(root, ".fakebin");
  mkdirSync(binDir, { recursive: true });
  const claude = join(binDir, "claude");
  writeFileSync(
    claude,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_TRAIN_IMPL)} "$@"\n`,
    "utf8",
  );
  chmodSync(claude, 0o755);

  return {
    root,
    expertDir: join(root, ".tldrx", "experts", EXPERT),
    binDir,
    statePath: join(root, ".fakebin", "calls"),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A knowledge file that validates: four sourced sections plus a prose recap. */
export function knowledgeMd(options: { readonly extraItem?: string; readonly secondFile?: boolean } = {}): string {
  return [
    `# ${AREA} — ${EXPERT}`,
    "",
    "## Invariants",
    "",
    "- An empty authorisation code is refused before any request is made [src: api:src/auth/oauth.ts:7]",
    ...(options.extraItem === undefined ? [] : [options.extraItem]),
    "",
    "## Entry points",
    "",
    "- `exchange()` is the only way in from the outside [src: api:src/auth/oauth.ts:6]",
    "",
    "## Business rules",
    "",
    ...(options.secondFile === false
      ? ["- The token is held for the process lifetime [src: api:src/auth/oauth.ts:9]"]
      : ["- The token is written to the shared store on success [src: api:src/auth/token.ts:5]"]),
    "",
    "## Gotchas",
    "",
    "- There is no refresh path at all [src: absent:api/src/auth/refresh.ts]",
    "",
    "## Sources",
    "",
    "`api:src/auth/oauth.ts` is the exchange; `api:src/auth/token.ts` is where the result lands.",
    "",
  ].join("\n");
}

/** A from-runs file that validates: two sourced sections plus a prose recap. */
export function fromRunsMd(): string {
  return [
    `# ${AREA} — from past runs`,
    "",
    "## Recurring decisions",
    "",
    "- Token storage stays in-process rather than growing a store [src: tldrx-work/260820-oauth/02-how/handoff.md:12]",
    "- Scopes are fixed rather than configured [src: F001]",
    "",
    "## Recurring patterns",
    "",
    "- The token store is read before the exchange is touched [src: tldrx-work/260820-oauth/retro.md:4]",
    "",
    "## Sources",
    "",
    "One handoff, one retro and one fact, all from run 260820-oauth.",
    "",
  ].join("\n");
}
