/**
 * Everything `tldrx init` needs to know before it touches a disk.
 *
 * There is no hidden default: if a value is not here, it was detected, and if it
 * was detected there is a citation for it.
 */
import { METHODOLOGIES, type Methodology } from "../schemas/process.ts";

export const PROVIDER_PREFERENCES = ["auto", "graphify", "static"] as const;
export type ProviderPreference = (typeof PROVIDER_PREFERENCES)[number];

export interface InitOptions {
  /** Absolute workspace root to detect. */
  readonly root: string;
  /**
   * Absolute directory that receives `.tldrx/`, `.gitignore` and `CLAUDE.md`.
   * Defaults to `root`; a different value keeps a real workspace untouched
   * while still mapping it. `[assumption]` — the spec has no such flag.
   */
  readonly out: string;
  /** Skip writing `init-questions.md`. */
  readonly interview: boolean;
  /** `--process`; `null` means "ask, do not assume" (spec §2.12). */
  readonly methodology: Methodology | null;
  /** Run `claude mcp list` and record the result in `workspace.yml` (slow). */
  readonly mcp: boolean;
  /**
   * `--stack ts,dotnet` — the languages this project INTENDS to use, for a
   * workspace with no code to detect them from. Each one seeds a `<lang>-stack`
   * expert and suppresses the greenfield stack question. Empty means "ask".
   */
  readonly stack: readonly string[];
  readonly provider: ProviderPreference;
  /**
   * Run each detected build/test/typecheck command once and record the outcome under
   * `command_probes:` (#168). `--no-probe` turns it off, and the skip is written into
   * every row as its reason rather than leaving the key absent.
   *
   * Required, not defaulted: `init` writing commands it never ran is the bug this
   * fixes, and an optional field would let a new caller reintroduce it silently.
   */
  readonly probe: boolean;
}

export function isMethodology(value: string): value is Methodology {
  return (METHODOLOGIES as readonly string[]).includes(value);
}

export function isProviderPreference(value: string): value is ProviderPreference {
  return (PROVIDER_PREFERENCES as readonly string[]).includes(value);
}
