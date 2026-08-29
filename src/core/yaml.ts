/**
 * YAML access, in one place.
 *
 * Bun 1.3.14 ships `Bun.YAML.parse` / `Bun.YAML.stringify` natively, so the
 * framework carries ZERO runtime dependencies for its file format. If this ever
 * has to run off Bun, replace the two function bodies below and nothing else.
 */

export function parseYaml(text: string): unknown {
  return Bun.YAML.parse(text);
}

export function stringifyYaml(value: unknown): string {
  return Bun.YAML.stringify(value);
}

export async function readYamlFile(path: string): Promise<unknown> {
  const text = await Bun.file(path).text();
  return parseYaml(text);
}
