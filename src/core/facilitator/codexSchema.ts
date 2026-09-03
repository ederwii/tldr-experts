/**
 * Codex structured output requires every object property to be required.
 * Represent an optional property as nullable on this wire only: Claude and
 * attended bundles retain the original schema. Review parsers already treat
 * null optional values as absent; mandatory verdict/evidence fields stay strict.
 */
export function codexSchema(schema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...schema };
  if (isRecord(schema.properties)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    result.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => {
      const child = isRecord(value) ? codexSchema(value) : value;
      return [key, required.includes(key) ? child : { anyOf: [child, { type: "null" }] }];
    }));
    result.required = Object.keys(schema.properties);
    result.additionalProperties = false;
  }
  if (isRecord(schema.items)) result.items = codexSchema(schema.items);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
