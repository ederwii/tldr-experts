/**
 * Convention signals: the config files that actually enforce a convention.
 *
 * A linter config is evidence. A style paragraph in a README is a claim, and it
 * is not collected here. `map/conventions.md` and `.tldrx/conventions/<repo>.md`
 * are both rendered from this list.
 */
import { join } from "node:path";
import { lineOf } from "../detect/lineOf.ts";
import { runtime } from "../runtime/index.ts";

export interface ConventionSignal {
  /** Repo-relative path of the config file. */
  readonly path: string;
  readonly line: number;
  readonly what: string;
}

interface Candidate {
  readonly files: readonly string[];
  readonly what: string;
  /** When set, the signal is only recorded if the file contains this text. */
  readonly contains?: string;
}

const CANDIDATES: readonly Candidate[] = [
  { files: ["eslint.config.js", "eslint.config.mjs", "eslint.config.ts", ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml"], what: "ESLint enforces lint rules" },
  { files: ["biome.json", "biome.jsonc"], what: "Biome enforces lint and format rules" },
  { files: [".prettierrc", ".prettierrc.json", ".prettierrc.js", ".prettierrc.yml", "prettier.config.js", "prettier.config.mjs"], what: "Prettier enforces formatting" },
  { files: [".editorconfig"], what: "EditorConfig sets indentation and line endings" },
  { files: ["tsconfig.json"], what: "TypeScript runs in strict mode", contains: "\"strict\": true" },
  { files: ["tsconfig.json"], what: "TypeScript compiler options are pinned" },
  { files: ["ruff.toml", ".ruff.toml"], what: "Ruff enforces lint rules" },
  { files: [".flake8", "setup.cfg"], what: "flake8 enforces lint rules", contains: "flake8" },
  { files: ["Directory.Build.props"], what: "MSBuild properties apply to every project" },
  { files: [".globalconfig", "stylecop.json"], what: "Roslyn analyzers enforce style" },
  { files: ["rustfmt.toml"], what: "rustfmt enforces formatting" },
  { files: [".golangci.yml", ".golangci.yaml"], what: "golangci-lint enforces lint rules" },
  { files: ["CONTRIBUTING.md"], what: "Contribution rules are written down" },
  { files: ["CLAUDE.md"], what: "Agent-facing conventions are written down" },
];

export async function detectConventionSignals(repoDir: string): Promise<ConventionSignal[]> {
  const signals: ConventionSignal[] = [];
  const seen = new Set<string>();

  for (const candidate of CANDIDATES) {
    for (const file of candidate.files) {
      const absPath = join(repoDir, file);
      if (!(await runtime.exists(absPath))) continue;
      const key = `${file}|${candidate.what}`;
      if (seen.has(key)) continue;

      let line = 1;
      if (candidate.contains !== undefined) {
        const text = await runtime.readText(absPath);
        if (!text.includes(candidate.contains)) continue;
        line = lineOf(text, candidate.contains);
      }
      seen.add(key);
      signals.push({ path: file, line, what: candidate.what });
      break;
    }
  }
  return signals;
}

/** Paths worth reporting as absent when nothing was found. */
export const CONVENTION_GAP_PATHS: readonly string[] = ["eslint.config.js", ".editorconfig"];
