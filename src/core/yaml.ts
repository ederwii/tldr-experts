/**
 * YAML access, in one place.
 *
 * Parsing and serialisation go through the runtime seam (`src/core/runtime/`):
 * on Bun that is the native YAML implementation, on Node it is the `yaml` npm
 * package inlined by the build. Nothing else in the framework touches YAML
 * directly, so the host runtime is a detail of one folder.
 */
import { readFileSync } from "node:fs";
import { runtime } from "./runtime/index.ts";

export function parseYaml(text: string): unknown {
  return runtime.parseYaml(text);
}

export function stringifyYaml(value: unknown): string {
  return runtime.stringifyYaml(value);
}

export async function readYamlFile(path: string): Promise<unknown> {
  return parseYaml(await runtime.readText(path));
}

/** Sync twin, for the hooks — they have a 50 ms budget and no room to await. */
export function readYamlFileSync(path: string): unknown {
  return parseYaml(readFileSync(path, "utf8"));
}
