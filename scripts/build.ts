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
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";

const NODE_SHEBANG = "#!/usr/bin/env node";
const DIST = join(FRAMEWORK_ROOT, "dist");

async function build(entrypoints: readonly string[], outdir: string, splitting = false): Promise<void> {
  const result = await Bun.build({ entrypoints: [...entrypoints], outdir, target: "node", splitting });
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${String(log)}\n`);
    throw new Error(`bun build failed for ${entrypoints.join(", ")}`);
  }
}

/** Force `#!/usr/bin/env node` as line 1, whatever the bundler copied over. */
function fixShebang(path: string): void {
  const text = readFileSync(path, "utf8");
  const body = text.startsWith("#!") ? text.slice(text.indexOf("\n") + 1) : text;
  writeFileSync(path, `${NODE_SHEBANG}\n${body}`, "utf8");
}

rmSync(DIST, { recursive: true, force: true });

const hookSources = readdirSync(join(FRAMEWORK_ROOT, "src", "hooks"))
  .filter((name) => name.endsWith(".ts"))
  .sort()
  .map((name) => join(FRAMEWORK_ROOT, "src", "hooks", name));

await build([join(FRAMEWORK_ROOT, "bin", "tldrx.ts")], DIST);
await build(hookSources, join(DIST, "hooks"), true);

fixShebang(join(DIST, "tldrx.js"));
for (const source of hookSources) {
  fixShebang(join(DIST, "hooks", source.split("/").pop()!.replace(/\.ts$/, ".js")));
}

process.stdout.write(
  `built dist/tldrx.js and ${hookSources.length} hook bundle(s) in dist/hooks/ (target=node)\n`,
);
