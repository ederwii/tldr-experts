/**
 * Generate the site's exhaustive CLI reference from `src/cli/helpText.ts`.
 *
 * The site must never carry a second, hand-maintained copy of the command surface. It
 * carried none at all, which turned out to be worse: `docs-site/reference/cli.md` is a
 * curated MAP that names roughly half the flags and links out to a markdown file in the
 * repo for the rest — and `docs/` is not in the site's `srcDir`, so that "exhaustive
 * version" was never on the website. On 2026-09-06 the owner went looking for `--yolo`,
 * the flag that turns off per-tool permission prompts, and the only hit on the whole site
 * was the changelog.
 *
 * So this reads the registry three other callers already read — `tldrx <cmd> --help`
 * renders it, the argv guard refuses a flag that is not in it, a drift test asserts every
 * flag the code READS is declared in it — and writes it out as two pages. A flag cannot be
 * added to the CLI without appearing here, and cannot appear here without being real.
 * `test/docs-cli-coverage.test.ts` asserts both directions.
 *
 * The Spanish page is framed in Spanish and keeps the flag meanings in English, for the
 * same reason `docs-site/reference/changelog.md` is not translated and sample CLI strings
 * stay in English (AGENTS.md §5): a translated copy of 180 meanings is a second copy, and
 * it would drift from the registry the first time a meaning changed.
 *
 * Run by `bun run build` and `bun run dev` in docs-site/. The output is gitignored.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ALL_EXIT_CODES, EXIT_MEANINGS, HELP_ENTRIES, flagLabel, flagValues, subcommandsOf,
} from "../../src/cli/helpText.ts";
import type { CommandHelp, FlagHelp } from "../../src/cli/helpText.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const REPO = "https://github.com/ederwii/tldr-experts";

export type Locale = "en" | "es";

/**
 * Escape the `<` that would otherwise become an HTML tag, outside code spans.
 *
 * A meaning or a note carrying `<sandbox>/progress.json` or `every <run> in` reaches
 * VitePress as raw HTML and then reaches the Vue compiler as an element that never closes —
 * `docs:build` fails with "Element is missing end tag", pointing at wherever the parser gave
 * up rather than at the `<`. Inside a code span markdown-it already escapes it, and `&lt;`
 * there would render as the five literal characters, so those are left alone.
 */
const prose = (text: string): string =>
  text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/</g, "&lt;")))
    .join("");

/**
 * The same, plus the pipe escaping a markdown table cell needs. A `|` ends the cell wherever
 * it appears — `--gates <a,b|all>` inside a code span included — and `\|` is the escape GFM
 * honours on both sides of one.
 */
export const cell = (text: string): string => prose(text).replace(/\|/g, "\\|");

/** A code span for a table cell: the pipes inside `--gates <a,b|all>` still split it. */
const code = (text: string): string => `\`${text.replace(/\|/g, "\\|")}\``;

/** Every string the page frames itself with. One shape, one per locale, no optionals. */
interface Strings {
  readonly title: string;
  readonly intro: string;
  readonly generated: string;
  readonly authority: string;
  readonly map: string;
  readonly exitHeading: string;
  readonly exitIntro: string;
  readonly everywhereHeading: string;
  readonly everywhere: readonly string[];
  readonly envHeading: string;
  readonly commandsHeading: string;
  readonly colFlag: string;
  readonly colMeaning: string;
  readonly colWhere: string;
  readonly colArg: string;
  readonly argsHeading: string;
  readonly subHeading: string;
  readonly examplesHeading: string;
  readonly exitsLabel: string;
  readonly notesHeading: string;
  readonly values: string;
  readonly repeatable: string;
  readonly passthrough: string;
}

const STRINGS: Record<Locale, Strings> = {
  en: {
    title: "Every command and flag",
    intro: [
      "Every command tldrx has, every flag it declares, the allowed values of every closed",
      "set, and the exit codes each one can return.",
    ].join(" "),
    generated: [
      "This page is **generated at build time** from `src/cli/helpText.ts` — the one registry",
      "that `tldrx <command> --help` renders, that the argv guard rejects unknown flags from,",
      "and that a drift test holds against the code. It cannot describe a flag that does not",
      "exist, and a flag cannot be added without appearing here.",
    ].join(" "),
    authority: "`tldrx <command> --help` on your own machine is the authority, and it needs no workspace, no run and no network. This page is that output, for a reader who has not installed anything yet.",
    map: "For a shorter, curated tour of the same surface, see [CLI overview](/reference/cli).",
    exitHeading: "Exit codes",
    exitIntro: "One table, defined in `src/cli/exitCodes.ts`. Each command lists below the subset it can return. Ctrl-C on a spawning command exits `130`.",
    everywhereHeading: "Rules that hold everywhere",
    everywhere: [
      "**An unknown flag is refused**, not ignored. `tldrx status --nope` is exit `1`.",
      "**`--json` is supported or it is an error.** Where a command has no JSON shape, passing it is exit `1` with `--json is not supported by <cmd>` — never a silent no-op.",
      "**`--help`** on any command prints its usage, flags, allowed values, examples and exit codes, and exits `0` without needing a workspace.",
      "**`--root <path>`** works on every command that touches a workspace. Omitted, they use the nearest `.tldrx/` at or above the cwd.",
      "**Ambiguity is refused.** With several runs open and no id, a run-targeting command lists them and refuses rather than guessing. `run status` is the exception: it lists them and exits `0`, because it is the screen you read to find the id.",
      "**stdout is data, stderr is progress.** The progress view (`--ui`) never touches stdout, so `tldrx run status --json | jq` is unaffected by it.",
    ],
    envHeading: "Environment variables",
    commandsHeading: "The commands",
    colFlag: "Flag",
    colMeaning: "Meaning",
    colWhere: "Subcommand",
    colArg: "Argument",
    argsHeading: "Arguments",
    subHeading: "Subcommands",
    examplesHeading: "Examples",
    exitsLabel: "Exit codes",
    notesHeading: "Notes",
    values: "Values",
    repeatable: "Repeatable — passing it twice adds a second value.",
    passthrough: "Everything after the script name is forwarded to it unchanged, so this command judges no flags of its own.",
  },
  es: {
    title: "Todos los comandos y flags",
    intro: [
      "Todos los comandos de tldrx, todos los flags que declara, los valores permitidos de",
      "cada conjunto cerrado y los códigos de salida que devuelve cada uno.",
    ].join(" "),
    generated: [
      "Esta página se **genera al compilar** a partir de `src/cli/helpText.ts`: el único",
      "registro que `tldrx <comando> --help` imprime, del que el guardián de argv rechaza los",
      "flags desconocidos, y que un test de deriva contrasta contra el código. No puede",
      "describir un flag que no existe, y no se puede añadir un flag sin que aparezca aquí.",
    ].join(" "),
    authority: "La autoridad es `tldrx <comando> --help` en tu propia máquina: no necesita workspace, ni run, ni red. Esta página es esa salida, para quien todavía no ha instalado nada. Los significados van en inglés, igual que las cadenas de la CLI.",
    map: "Para un recorrido más corto y curado de la misma superficie, mira el [Resumen de la CLI](/es/reference/cli).",
    exitHeading: "Códigos de salida",
    exitIntro: "Una sola tabla, definida en `src/cli/exitCodes.ts`. Cada comando lista abajo el subconjunto que puede devolver. Ctrl-C sobre un comando que lanza un sub-agente sale con `130`.",
    everywhereHeading: "Reglas que valen en todas partes",
    everywhere: [
      "**Un flag desconocido se rechaza**, no se ignora. `tldrx status --nope` sale con `1`.",
      "**O `--json` está soportado, o es un error.** Donde un comando no tiene forma JSON, pasarlo sale con `1` y `--json is not supported by <cmd>`; nunca es un no-op silencioso.",
      "**`--help`** en cualquier comando imprime su uso, sus flags, los valores permitidos, ejemplos y códigos de salida, y sale con `0` sin necesitar un workspace.",
      "**`--root <path>`** funciona en todo comando que toque un workspace. Sin él, usan el `.tldrx/` más cercano en el cwd o por encima.",
      "**La ambigüedad se rechaza.** Con varios runs abiertos y sin id, un comando que apunta a un run los lista y se niega, en vez de adivinar. `run status` es la excepción: los lista y sale con `0`, porque es la pantalla donde lees el id.",
      "**stdout son datos, stderr es progreso.** La vista de progreso (`--ui`) nunca toca stdout, así que `tldrx run status --json | jq` no se ve afectado.",
    ],
    envHeading: "Variables de entorno",
    commandsHeading: "Los comandos",
    colFlag: "Flag",
    colMeaning: "Significado",
    colWhere: "Subcomando",
    colArg: "Argumento",
    argsHeading: "Argumentos",
    subHeading: "Subcomandos",
    examplesHeading: "Ejemplos",
    exitsLabel: "Códigos de salida",
    notesHeading: "Notas",
    values: "Valores",
    repeatable: "Repetible: pasarlo dos veces añade un segundo valor.",
    passthrough: "Todo lo que va después del nombre del script se le reenvía sin tocar, así que este comando no juzga flags propios.",
  },
};

/**
 * The environment variables the runtime reads, with what each one does.
 *
 * Written here rather than derived: an env var is read by `process.env.X` at a dozen call
 * sites and nothing in the code says what it MEANS. `test/docs-cli-coverage.test.ts` holds
 * this list against a grep of `src/`, so a new variable cannot land undocumented.
 */
export const ENV_VARS: readonly (readonly [string, string])[] = [
  ["TLDRX_UI", "The progress view, same values as `--ui`. The flag wins where both are given."],
  ["TLDRX_AGENT_PROVIDER", "Which automated runner spawns: `claude` (default) or `codex`."],
  ["TLDRX_CLAUDE_BIN", "Which binary a Claude sub-agent spawn executes. Default `claude`, taken off `PATH`. It replaces the executable NAME only — the arguments are still Claude Code's, so whatever it points at has to speak them."],
  ["TLDRX_CODEX_BIN", "Which Codex binary the runner executes. Default `codex`, taken off `PATH`. Same late-bound wrapper use as `TLDRX_CLAUDE_BIN`."],
  ["TLDRX_UPDATE_CHECK", "`off` (also `0`, `false`, `no`, `never`) silences the new-version notice. `update_check: off` in `~/.tldrx/config.yml` does it for the machine."],
  ["TLDRX_LEARN_SCRIPT", "Feeds `tldrx learn` a scripted sequence of keypresses instead of a terminal. For the tutorial's own tests; not part of ordinary use."],
];

function flagRows(command: CommandHelp, s: Strings): string[] {
  const grouped = command.flags.some((flag) => flag.sub !== undefined);
  const header = grouped
    ? [`| ${s.colFlag} | ${s.colWhere} | ${s.colMeaning} |`, "|---|---|---|"]
    : [`| ${s.colFlag} | ${s.colMeaning} |`, "|---|---|"];
  const rows = command.flags.map((flag: FlagHelp) => {
    const values = flagValues(flag);
    const meaning = cell(flag.meaning)
      + (values.length > 0 ? ` ${s.values}: ${values.map((v) => `\`${v}\``).join(" ")}.` : "")
      + (flag.repeatable === true ? ` ${s.repeatable}` : "");
    const label = code(flagLabel(flag).trim());
    return grouped
      ? `| ${label} | ${flag.sub === undefined ? "*(all)*" : `\`${flag.sub}\``} | ${meaning} |`
      : `| ${label} | ${meaning} |`;
  });
  return [...header, ...rows];
}

function renderCommand(command: CommandHelp, s: Strings): string[] {
  const out: string[] = [`## \`tldrx ${command.name}\``, "", prose(command.description), ""];

  const subs = subcommandsOf(command.name);
  if (subs.length > 0) {
    out.push(`**${s.subHeading}:** ${subs.map((sub) => `\`${sub}\``).join(" · ")}`, "");
  }

  if (command.args.length > 0) {
    out.push(`| ${s.colArg} | ${s.colMeaning} |`, "|---|---|");
    for (const arg of command.args) out.push(`| ${code(arg.name)} | ${cell(arg.meaning)} |`);
    out.push("");
  }

  if (command.flags.length > 0) out.push(...flagRows(command, s), "");
  if (command.passthrough === true) out.push(s.passthrough, "");

  out.push(`**${s.exitsLabel}:** ${[...command.exits].sort((a, b) => a - b).map((c) => `\`${String(c)}\``).join(" ")}`, "");

  if (command.examples.length > 0) {
    out.push("```bash", ...command.examples, "```", "");
  }

  const notes = command.notes ?? [];
  if (notes.length > 0) {
    for (const note of notes) out.push(`- ${prose(note)}`);
    out.push("");
  }
  return out;
}

/** The whole page, for one locale. Pure: no disk, no env, no clock. */
export function renderCliReference(locale: Locale): string {
  const s = STRINGS[locale];
  const out: string[] = [
    "---",
    `title: ${s.title}`,
    "---",
    "",
    `# ${s.title}`,
    "",
    s.intro,
    "",
    `::: tip`,
    s.generated,
    ":::",
    "",
    s.authority,
    "",
    s.map,
    "",
    `## ${s.exitHeading}`,
    "",
    s.exitIntro,
    "",
    "| | |",
    "|---|---|",
    ...[...ALL_EXIT_CODES].sort((a, b) => a - b)
      .map((code) => `| \`${String(code)}\` | ${EXIT_MEANINGS.get(code) ?? ""} |`),
    "",
    `## ${s.everywhereHeading}`,
    "",
    ...s.everywhere.map((rule) => `- ${rule}`),
    "",
    `## ${s.envHeading}`,
    "",
    "| | |",
    "|---|---|",
    ...ENV_VARS.map(([name, meaning]) => `| \`${name}\` | ${cell(meaning)} |`),
    "",
    `# ${s.commandsHeading}`,
    "",
  ];

  for (const command of HELP_ENTRIES) out.push(...renderCommand(command, s));

  out.push(
    "---",
    "",
    locale === "en"
      ? `Generated from [\`src/cli/helpText.ts\`](${REPO}/blob/main/src/cli/helpText.ts). Prose that a flag table cannot hold — worked examples, the reasoning behind a refusal — lives in [the repo's guide](${REPO}/blob/main/docs/guide/08-cli-reference.md).`
      : `Generado desde [\`src/cli/helpText.ts\`](${REPO}/blob/main/src/cli/helpText.ts). Lo que una tabla de flags no puede sostener — ejemplos trabajados, el razonamiento detrás de un rechazo — vive en [la guía del repo](${REPO}/blob/main/docs/guide/08-cli-reference.md) (en inglés).`,
    "",
  );
  return out.join("\n");
}

function write(locale: Locale): void {
  const target = locale === "en"
    ? join(HERE, "..", "reference", "cli-flags.md")
    : join(HERE, "..", "es", "reference", "cli-flags.md");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderCliReference(locale), "utf8");
  process.stdout.write(`gen-cli: ${target}\n`);
}

if (import.meta.main) {
  write("en");
  write("es");
}
