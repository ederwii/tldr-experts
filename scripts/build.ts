#!/usr/bin/env bun
/**
 * Build the Node-runnable bundle.
 *
 * Portability decision (2026-08-28): **Bun to build, Node or Bun to run.** This
 * script is the "Bun to build" half. It bundles the CLI and every hook with
 * `--target=node`, which inlines the one devDependency (`yaml`) so an installed
 * tldrx resolves zero runtime dependencies.
 *
 *   dist/tldrx.js          <- bin/tldrx.ts        (package.json `bin`)
 *   dist/hooks/<name>.js   <- src/hooks/<name>.ts (plugin hooks.json targets)
 *   dist/hooks/chunk-*.js  <- the code those seven share
 *
 * The hooks are built with `splitting: true` because they overlap almost
 * completely — every one of them parses YAML. Without it each of the seven
 * inlined its own copy of the parser and came out ~250 KB (1.9 MB of hooks in a
 * 2.4 MB package); with it the entry points are 2–5 KB each over one shared
 * chunk, and `dist/` is 928 KB. Chunk names are content-hashed and imported
 * relatively, so `hooks.json` still points at the named entry files and nothing
 * outside this directory needs to know they exist. `dist/tldrx.js` is a single
 * entry point and stays unsplit — one file to `node`.
 *
 * Bun copies the source shebang into the output, so every entry point comes out
 * saying `#!/usr/bin/env bun`. That is exactly wrong for a Node bundle, so the
 * last step rewrites it. Exits non-zero on any failure — no pipes, no swallowing.
 *
 * That last step also strips Bun's `// @bun` header. The marker tells the Bun
 * *runtime* "this file is already transpiled, load it raw" — and on bun 1.3.14
 * that raw-load path decodes the file as latin-1, so every non-ASCII source
 * literal comes out double-encoded: `·` (`c2 b7` in the bundle, which is correct
 * UTF-8) prints as `Â·` (`c3 82 c2 b7`). Measured: `bun dist/tldrx.js status`
 * printed `c3 82 c2 b7`, `node dist/tldrx.js status` printed `c2 b7`, and
 * deleting the one marker line made bun agree with node. `node` ignores the
 * comment either way, so dropping it costs the Node path nothing and costs the
 * Bun path one transpile (~4 ms measured over 10 runs of `--version`: 32 ms →
 * 36 ms). We ship one bundle that both runtimes must read identically; a 4 ms
 * parse is the price of that.
 */
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";

const NODE_SHEBANG = "#!/usr/bin/env node";
/** Bun's "already transpiled" header — see the note above on why it must go. */
const BUN_MARKER = "// @bun";
const DIST = join(FRAMEWORK_ROOT, "dist");

async function build(entrypoints: readonly string[], outdir: string, splitting = false): Promise<void> {
  const result = await Bun.build({ entrypoints: [...entrypoints], outdir, target: "node", splitting });
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${String(log)}\n`);
    throw new Error(`bun build failed for ${entrypoints.join(", ")}`);
  }
}

/**
 * Drop Bun's `// @bun` header wherever it sits — first line, or the line after a
 * shebang. Applied to every emitted file, not just the entry points: which
 * outputs carry the marker is the bundler's business, and a chunk that starts
 * carrying it tomorrow would resurrect the latin-1 bug in a file nobody edits.
 */
function stripBunMarker(text: string): string {
  const lines = text.split("\n");
  const at = lines[0]?.startsWith("#!") === true ? 1 : 0;
  if (lines[at]?.trimEnd() !== BUN_MARKER) return text;
  lines.splice(at, 1);
  return lines.join("\n");
}

/** Force `#!/usr/bin/env node` as line 1, whatever the bundler copied over. */
function forceNodeShebang(text: string): string {
  const body = text.startsWith("#!") ? text.slice(text.indexOf("\n") + 1) : text;
  return `${NODE_SHEBANG}\n${body}`;
}

/** Every `.js` under `dir`, recursively — entry points and content-hashed chunks alike. */
function emittedFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return emittedFiles(path);
    return name.endsWith(".js") ? [path] : [];
  });
}

rmSync(DIST, { recursive: true, force: true });

const hookSources = readdirSync(join(FRAMEWORK_ROOT, "src", "hooks"))
  .filter((name) => name.endsWith(".ts"))
  .sort()
  .map((name) => join(FRAMEWORK_ROOT, "src", "hooks", name));

await build([join(FRAMEWORK_ROOT, "bin", "tldrx.ts")], DIST);
await build(hookSources, join(DIST, "hooks"), true);

const entryPoints = new Set([
  join(DIST, "tldrx.js"),
  ...hookSources.map((s) => join(DIST, "hooks", s.split("/").pop()!.replace(/\.ts$/, ".js"))),
]);

for (const path of emittedFiles(DIST)) {
  const text = stripBunMarker(readFileSync(path, "utf8"));
  writeFileSync(path, entryPoints.has(path) ? forceNodeShebang(text) : text, "utf8");
}

process.stdout.write(
  `built dist/tldrx.js and ${hookSources.length} hook bundle(s) in dist/hooks/ (target=node)\n`,
);
