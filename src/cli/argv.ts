/**
 * The smallest argv parser that does this job honestly.
 *
 * `--flag value`, `--flag=value` and bare `--flag` (which becomes `true`).
 * Everything else is a positional. No aliases, no coercion, no guessing what the
 * user meant — a command that needs a number asks for one and says so when it does
 * not get one.
 *
 * A flag given twice keeps winning in `flags` (last one wins, unchanged), AND
 * every value is kept in `repeats`. Only a command that asks — via
 * `repeatedFlag` — sees the list; every existing reader is byte-identical.
 */

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
  /** Flag name -> every string value it was given, in argv order. */
  readonly repeats: ReadonlyMap<string, readonly string[]>;
}

/** Flags that always take a value, so `--note` never swallows the next flag. */
export function parseArgs(argv: readonly string[], valueFlags: readonly string[] = []): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const repeats = new Map<string, string[]>();
  const takesValue = new Set(valueFlags);

  const set = (name: string, value: string | true): void => {
    flags.set(name, value);
    if (typeof value !== "string") return;
    const seen = repeats.get(name);
    if (seen === undefined) repeats.set(name, [value]);
    else seen.push(value);
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (takesValue.has(body) && next !== undefined && !next.startsWith("--")) {
      set(body, next);
      i++;
      continue;
    }
    set(body, true);
  }
  return { positionals, flags, repeats };
}

/**
 * Every value a repeatable flag was given, in argv order — `[]` when it was never
 * passed. `--seed a --seed b` is two seeds, not "b won"; `stringFlag` still
 * answers "b" for every caller that only ever wanted one.
 */
export function repeatedFlag(args: ParsedArgs, name: string): readonly string[] {
  return args.repeats.get(name) ?? [];
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

export class UsageError extends Error {}

export function numberFlag(args: ParsedArgs, name: string): number | undefined {
  const value = stringFlag(args, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} expects a number, got '${value}'`);
  return n;
}

export function listFlag(args: ParsedArgs, name: string): readonly string[] | undefined {
  const value = stringFlag(args, name);
  if (value === undefined) return undefined;
  return value.split(",").map((part) => part.trim()).filter((part) => part !== "");
}

/**
 * Every `--flag` in argv, in order, with its value already accounted for.
 *
 * The same scan `parseArgs` does, minus the bookkeeping: `--flag=value` yields
 * `flag`, and `--flag value` yields `flag` and skips the value when `flag` is one
 * that takes one — so a VALUE that happens to look like a flag is never mistaken
 * for one. A bare `--` yields nothing.
 *
 * It exists so the dispatcher can refuse a flag no command reads. Until it did,
 * `tldrx status --nope` exited 0: the parser recorded `nope` and nothing ever
 * asked for it, so a typo silently ran the command with its defaults.
 */
export function flagNames(argv: readonly string[], valueFlags: ReadonlySet<string>): readonly string[] {
  const names: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    if (body === "") continue;
    const eq = body.indexOf("=");
    if (eq !== -1) {
      names.push(body.slice(0, eq));
      continue;
    }
    names.push(body);
    const next = argv[i + 1];
    if (valueFlags.has(body) && next !== undefined && !next.startsWith("--")) i++;
  }
  return names;
}

/** The first flag in argv that `known` does not contain, or null when all are known. */
export function firstUnknownFlag(
  argv: readonly string[],
  known: ReadonlySet<string>,
  valueFlags: ReadonlySet<string>,
): string | null {
  for (const name of flagNames(argv, valueFlags)) {
    if (!known.has(name)) return name;
  }
  return null;
}
