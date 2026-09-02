/**
 * What model a training sub-agent will actually get when nobody passed
 * `--model` — resolved BEFORE the spawn, so the answer can be printed with a
 * price attached rather than discovered from an invoice.
 *
 * `runTraining` passes `--model` through to `claude` only when it has one
 * (`spawnAgent.ts:147`); with no flag the CLI picks for itself, and on 2026-09-02
 * what it picked was the operator's last-used model, `fable-5` (#96). That is a
 * defensible default for a chat session and an expensive one for a headless
 * sub-agent nobody is watching, so the least this framework can do is say which
 * one it will be.
 *
 * **`[assumption]` — the precedence below is the claude CLI's, as documented, not
 * something this repo can measure.** `ANTHROPIC_MODEL` overrides settings, a
 * project's `.claude/settings.local.json` overrides its `settings.json`, and both
 * override `~/.claude/settings.json`. If that order is wrong the consequence is
 * bounded: the pre-start line names a model the run does not use, and the reader
 * can see it is wrong because the name is printed. Nothing is refused on a model
 * this function could not read — `resolveAmbientModel` returns null and the
 * caller says "unknown" out loud (`trainPreflight.ts`).
 *
 * Pure over its inputs: the caller hands it an env and a list of files. Nothing
 * here reads `process.env` or `homedir()`, so a test never depends on the
 * developer's own `~/.claude/settings.json`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AmbientModel } from "./trainPreflight.ts";

/** The settings files the claude CLI reads for `model`, highest precedence first. */
export function ambientModelFiles(root: string, home: string): readonly string[] {
  return [
    join(root, ".claude", "settings.local.json"),
    join(root, ".claude", "settings.json"),
    join(home, ".claude", "settings.json"),
  ];
}

export interface AmbientModelInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The home directory, used only to shorten a path to `~/…` for the message. */
  readonly home: string;
  readonly files: readonly string[];
}

export function resolveAmbientModel(input: AmbientModelInput): AmbientModel | null {
  const fromEnv = (input.env["ANTHROPIC_MODEL"] ?? "").trim();
  if (fromEnv !== "") return { model: fromEnv, source: "$ANTHROPIC_MODEL" };

  for (const file of input.files) {
    const model = modelIn(file);
    if (model !== null) return { model, source: shorten(file, input.home) };
  }
  return null;
}

/**
 * The `model` key of one settings file, or null.
 *
 * Every failure is a null: missing, unreadable, unparseable, no `model`, a
 * `model` that is not a string. A malformed settings file is a reason to stay
 * quiet about the model, never a reason to fail a training run that would
 * otherwise have worked.
 */
function modelIn(path: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const model = (parsed as Record<string, unknown>)["model"];
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  return trimmed === "" ? null : trimmed;
}

/** `/Users/x/.claude/settings.json` → `~/.claude/settings.json`. */
function shorten(path: string, home: string): string {
  if (home !== "" && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}
