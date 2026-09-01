/**
 * `.tldrx/memory/finding-classes.yml` — the taxonomy, extended by the workspace
 * that owns the defects (#74).
 *
 * #64 shipped a CLOSED set of seven classes, deliberately: the rules are keyword
 * rules tested against fixtures, and an unbounded taxonomy cannot be. But a team
 * whose repeated defect is not one of the seven got `other` and had no way to say
 * so — the table told them the taxonomy was too small and gave them nothing to do
 * about it.
 *
 * Three properties make the extension safe to test, and they are the whole design:
 *
 *   - **Extensions sit BEFORE `other` and AFTER every built-in rule.** A workspace
 *     class can therefore only ever claim a finding the built-in rules left as
 *     `other`. It cannot re-label `test-cannot-fail`, so every fixture in
 *     `retro-all.test.ts` is immune to whatever any workspace writes here, and
 *     "the closed set is what is tested" stays true.
 *   - **Everything is bounded.** At most {@link MAX_CLASSES} classes of at most
 *     {@link MAX_RULES} rules each, every rule a compiled `RegExp`. There is no
 *     input to this file that makes a loop unbounded.
 *   - **A bad file is a REFUSAL, naming the file, the class and what is wrong with
 *     it** — never a crash, and never a silent fallback to the built-ins. A rule
 *     the author believes is running and is not would make every count a lie.
 *
 * Absence is not an error: no file means no extension, and that is the normal
 * case. `readFileSync` failing for any other reason IS an error — a file that
 * exists and cannot be read is a fact the operator needs.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { parseYaml } from "../yaml.ts";
import { FINDING_CLASSES } from "./taxonomy.ts";

/** Workspace-relative, and the string every refusal opens with. */
export const FINDING_CLASSES_FILE = `${PROJECT_FRAMEWORK_DIR}/memory/finding-classes.yml`;

/**
 * Bounds, not guesses about taste. A workspace with 40 recurring defect classes
 * has a different problem from the one this file solves, and a `retro --all`
 * table 40 rows long is not a table anyone reads.
 */
export const MAX_CLASSES = 16;
export const MAX_RULES = 16;

/** `flaky-timing` — lowercase, hyphenated, 2..40 characters. Reads as a class. */
const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;

/** One workspace-declared class: a name and the rules that fire it, in order. */
export interface ExtraClass {
  readonly name: string;
  readonly rules: readonly RegExp[];
}

/** A `finding-classes.yml` this loader will not act on, and exactly why. */
export class FindingClassesError extends Error {
  constructor(message: string) {
    super(`${FINDING_CLASSES_FILE}: ${message}`);
    this.name = "FindingClassesError";
  }
}

export function findingClassesPath(root: string): string {
  return join(root, FINDING_CLASSES_FILE);
}

/**
 * The workspace's extra classes, or `[]` when the file is not there.
 *
 * Throws {@link FindingClassesError} — and only that — for every other rejection,
 * so a caller has one type to catch and a message already fit to print.
 */
export function loadExtraClasses(root: string): readonly ExtraClass[] {
  const path = findingClassesPath(root);
  if (!existsSync(path)) return [];

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new FindingClassesError(`cannot be read — ${messageOf(error)}`);
  }

  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (error) {
    throw new FindingClassesError(`does not parse as YAML — ${messageOf(error)}`);
  }
  return parseExtraClasses(doc);
}

/** The validator, separated from the read so a caller can hold a document. */
export function parseExtraClasses(doc: unknown): readonly ExtraClass[] {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new FindingClassesError(
      "must be a mapping with `version: 1` and a `classes:` list at the top level",
    );
  }
  const record = doc as Record<string, unknown>;
  if (record["version"] !== 1) {
    throw new FindingClassesError(
      "must open with `version: 1` like every other data file this framework reads"
      + ` (found ${JSON.stringify(record["version"] ?? null)})`,
    );
  }
  const classes = record["classes"];
  if (classes === undefined) {
    throw new FindingClassesError("has no `classes:` key — that is the only thing it is for");
  }
  if (!Array.isArray(classes)) {
    throw new FindingClassesError("`classes:` must be a list of `{name, rules}` mappings");
  }
  if (classes.length === 0) {
    throw new FindingClassesError(
      "`classes:` must declare at least one class. A file that adds nothing is a file to"
      + " delete rather than to load: remove it and the built-in taxonomy is used.",
    );
  }
  if (classes.length > MAX_CLASSES) {
    throw new FindingClassesError(
      `declares ${String(classes.length)} classes; the cap is ${String(MAX_CLASSES)}.`
      + " A taxonomy nobody can hold in their head ranks nothing.",
    );
  }

  const parsed: ExtraClass[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of classes.entries()) {
    parsed.push(parseOne(entry, index, seen));
  }
  return parsed;
}

const BUILTIN = new Set<string>(FINDING_CLASSES);

function parseOne(entry: unknown, index: number, seen: Set<string>): ExtraClass {
  const at = `classes[${String(index)}]`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new FindingClassesError(`${at} must be a mapping with \`name\` and \`rules\``);
  }
  const record = entry as Record<string, unknown>;

  const name = record["name"];
  if (typeof name !== "string" || name.trim() === "") {
    throw new FindingClassesError(`${at} has no \`name\` — a class with no name cannot be reported`);
  }
  if (!NAME_RE.test(name)) {
    throw new FindingClassesError(
      `${at}: '${name}' is not a class name. Use lowercase letters, digits and hyphens,`
      + " 2 to 40 characters — the shape the built-in classes have, because the name is a"
      + " column heading and a JSON key.",
    );
  }
  if (BUILTIN.has(name)) {
    throw new FindingClassesError(
      `${at}: '${name}' is a built-in class. A workspace may ADD classes, never redefine one —`
      + " the built-in rules run first, so a redefinition would be silently dead.",
    );
  }
  if (seen.has(name)) {
    throw new FindingClassesError(`'${name}' is declared twice; each class is declared once`);
  }
  seen.add(name);

  const rules = record["rules"];
  if (rules === undefined) {
    throw new FindingClassesError(
      `${at} ('${name}') has no \`rules:\` — a class with no rule can never fire`,
    );
  }
  if (!Array.isArray(rules)) {
    throw new FindingClassesError(`${at} ('${name}'): \`rules:\` must be a list of regex strings`);
  }
  if (rules.length === 0) {
    throw new FindingClassesError(
      `${at} ('${name}'): \`rules:\` needs at least one pattern; a class with none can never fire`,
    );
  }
  if (rules.length > MAX_RULES) {
    throw new FindingClassesError(
      `${at} ('${name}') has ${String(rules.length)} rules; the cap is ${String(MAX_RULES)}`,
    );
  }

  return { name, rules: rules.map((rule, i) => parseRule(rule, name, at, i)) };
}

/**
 * One rule, compiled case-insensitively — the built-in rules all carry `/i`, and
 * a workspace rule that did not would behave differently for no stated reason.
 *
 * The empty-match check is the one that earns its place. `.*` and `""` both match
 * every string, including the empty one, so such a rule does not classify: it
 * swallows every finding the built-ins left, and the table it produces is a
 * single row that says nothing. That is a mistake worth naming, not honouring.
 */
function parseRule(rule: unknown, name: string, at: string, index: number): RegExp {
  const where = `${at} ('${name}') rules[${String(index)}]`;
  if (typeof rule !== "string") {
    throw new FindingClassesError(
      `${where} is ${JSON.stringify(rule)}; each rule must be a string holding a regular expression`,
    );
  }
  let compiled: RegExp;
  try {
    compiled = new RegExp(rule, "i");
  } catch (error) {
    throw new FindingClassesError(`${where}: '${rule}' is not a regular expression — ${messageOf(error)}`);
  }
  if (compiled.test("")) {
    throw new FindingClassesError(
      `${where}: '${rule}' matches every text, including the empty string, so it would claim`
      + " every unclassified finding. Narrow it, or the class means nothing.",
    );
  }
  return compiled;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
