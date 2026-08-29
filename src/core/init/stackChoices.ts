/**
 * The stack a greenfield project INTENDS to use.
 *
 * Detection reads manifests; a project with no code has none, so the only honest
 * source is the operator — `--stack ts,dotnet` or the interview answer. This
 * module is the one place that turns what they typed into the language ids the
 * rest of the framework already speaks (`typescript`, `dotnet`, … — the same ids
 * `detect/stack.ts` produces and `planExperts.ts` turns into `<lang>-stack`).
 *
 * Unknown values are NOT rejected: `--stack elixir` seeds an `elixir-stack`
 * expert with no areas beyond the language itself, which is a truthful stub. The
 * fixed list below is what the interview OFFERS, not what it accepts.
 * `[assumption]` — the spec has no stack flag at all.
 */

/** What the interview offers. Spec §2.7 caps a question at 5 options. */
export const STACK_CHOICES: readonly { readonly id: string; readonly label: string }[] = [
  { id: "typescript", label: "TypeScript / Node" },
  { id: "dotnet", label: ".NET / C#" },
  { id: "python", label: "Python" },
  { id: "go", label: "Go" },
];

/** Spellings people actually type, mapped onto the detector's language ids. */
const ALIASES: Readonly<Record<string, string>> = {
  ts: "typescript", tsx: "typescript", node: "typescript", nodejs: "typescript",
  js: "javascript", javascript: "javascript",
  cs: "dotnet", "c#": "dotnet", csharp: "dotnet", net: "dotnet", dotnetcore: "dotnet",
  py: "python", python3: "python",
  golang: "go",
  rs: "rust",
  jvm: "java", kt: "kotlin", rb: "ruby",
};

export function normaliseStack(value: string): string {
  const slug = value.trim().toLowerCase().replace(/^\.+/, "").replace(/[^a-z0-9#+]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ALIASES[slug] ?? slug;
}

/** `--stack ts,dotnet` -> `["typescript", "dotnet"]`, in order, deduplicated. */
export function parseStackFlag(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(",")) {
    const id = normaliseStack(part);
    if (id === "" || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}
