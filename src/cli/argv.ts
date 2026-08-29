/**
 * The smallest argv parser that does this job honestly.
 *
 * `--flag value`, `--flag=value` and bare `--flag` (which becomes `true`).
 * Everything else is a positional. No aliases, no coercion, no guessing what the
 * user meant — a command that needs a number asks for one and says so when it does
 * not get one.
 */

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

/** Flags that always take a value, so `--note` never swallows the next flag. */
export function parseArgs(argv: readonly string[], valueFlags: readonly string[] = []): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const takesValue = new Set(valueFlags);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (takesValue.has(body) && next !== undefined && !next.startsWith("--")) {
      flags.set(body, next);
      i++;
      continue;
    }
    flags.set(body, true);
  }
  return { positionals, flags };
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
