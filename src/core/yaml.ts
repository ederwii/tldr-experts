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

/**
 * Block style by default (indent 2): every YAML file this framework writes is
 * meant to be read and diffed by a human, and `Bun.YAML.stringify` with no
 * indent emits one flow-style line. Pass `indent: 0` for the compact form.
 */
export function stringifyYaml(value: unknown, indent = 2): string {
  return indent > 0 ? Bun.YAML.stringify(value, null, indent) : Bun.YAML.stringify(value);
}

export async function readYamlFile(path: string): Promise<unknown> {
  const text = await Bun.file(path).text();
  return parseYaml(text);
}
