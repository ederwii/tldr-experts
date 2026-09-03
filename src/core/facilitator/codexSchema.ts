/**
 * The framework's JSON schema, translated for Codex's strict structured output.
 *
 * MEASURED (gh #148, published 0.7.0 + codex-cli 0.153.0, a live Build smoke run):
 * the developer stage finished, four tests passed, and the review then died at the
 * API before the reviewer ran — `invalid_json_schema: fixlist.items.required must
 * include every property (missing n)`. Codex's structured-output API requires every
 * DECLARED property of an object to appear in that object's `required`; the review
 * contract declares optional fields at two levels (`fixlist` itself, and `n`,
 * `severity`, `where`, `detail`, `do_not` inside each item), and `spawnAgent` wrote
 * it to `--output-schema` verbatim. So every Codex review was refused before it
 * began, and the story paid an attempt for a turn that never ran.
 *
 * The translation lives HERE and is applied at the Codex spawn boundary alone
 * (`spawnAgent.ts`, the `provider === "codex"` branch) — one implementation, and the
 * shared contract does not move. `REVIEW_SCHEMA` and `ENVELOPE_SCHEMA` are untouched,
 * Claude's `--json-schema` still carries them byte for byte, and an attended
 * `--prepare` bundle still publishes the original shape.
 *
 * An optional property becomes `anyOf: [<its own schema>, {"type": "null"}]` and
 * joins `required`. Nullable rather than promoted-to-mandatory on purpose: making a
 * field genuinely required would force a reviewer to invent a value for something it
 * has nothing to say about, and `parseReview`/`parseFixFindings` already read a
 * `null` exactly as they read the absent field (`str(null)` is `""`, an absent `n`
 * takes its row index). Nothing about fail-closed moves — a `fixlist` verdict whose
 * list is unreadable is still `changes`.
 *
 * MEASURED that the translated schema is ACCEPTED, and not merely that it stops matching the
 * refusal's words: one real `codex exec -s read-only --output-schema <this function's output
 * for REVIEW_SCHEMA>` against an authenticated codex-cli 0.153.0 — the version the issue was
 * filed on — exited 0 and returned `{"verdict": "approve", …, "fixlist": null}`. Taken by the
 * pre-merge reviewer, in an isolated directory, once; no gate re-runs it, so a change to this
 * function is proven against the bytes the child reads (`test/model-provider.test.ts`) and
 * that live call is the thing to take again if the shape here ever moves.
 *
 * What it does NOT walk, stated rather than left to be discovered: `properties` and
 * `items` only. The two schemas that reach this seam — `ENVELOPE_SCHEMA` and
 * `REVIEW_SCHEMA` — are built from those two keywords and nothing else, so a
 * `$ref`, `$defs`, `oneOf` or `allOf` node would pass through unchanged and unsaid.
 * Whoever first writes one at this seam extends this function; it is not a silent
 * default, it is a shape nothing here has yet.
 */
export function codexSchema(schema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  // Spread first so every key the caller declared survives in its original order:
  // `ENVELOPE_SCHEMA`, whose properties are already all required, must come out of
  // here byte-identical to what went in, or the default Codex path would change
  // shape for a fix that is about the reviewer's schema.
  const result: Record<string, unknown> = { ...schema };
  if (isRecord(schema.properties)) {
    const required = Array.isArray(schema.required) ? (schema.required as readonly unknown[]) : [];
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
