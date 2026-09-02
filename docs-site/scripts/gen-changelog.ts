/**
 * Generate `docs-site/reference/changelog.md` from the repository's CHANGELOG.md.
 *
 * The site must never carry a second, hand-maintained copy of the changelog: two copies
 * drift, and the one on the website is the one a stranger reads. So this reads the real
 * file and writes a scannable extract of it — the release headings, their Added/Changed/
 * Fixed groups, and the bold lead of every top-level entry — and links out for the prose.
 *
 * Run by `bun run build` and `bun run dev` in docs-site/. The output is gitignored.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const SOURCE = join(HERE, "..", "..", "CHANGELOG.md");
const TARGET = join(HERE, "..", "reference", "changelog.md");
const REPO = "https://github.com/ederwii/tldr-experts";

/** Top-level bullets can wrap over several lines; a new one only ever starts at column 0. */
function bullets(block: string[]): string[] {
  const out: string[] = [];
  let current: string[] | null = null;
  for (const line of block) {
    if (line.startsWith("- ")) {
      if (current) out.push(current.join(" "));
      current = [line.slice(2).trim()];
    } else if (current && line.startsWith("  ") && !/^\s+[-*]\s/.test(line)) {
      current.push(line.trim());
    } else if (current && (line.trim() === "" || /^\s+[-*]\s/.test(line))) {
      out.push(current.join(" "));
      current = null;
    }
  }
  if (current) out.push(current.join(" "));
  return out;
}

/** The bold lead of an entry, else its first sentence. Trimmed to one readable line. */
function headline(entry: string): string {
  const bold = /^\*\*(.+?)\*\*/s.exec(entry);
  let text = bold ? bold[1]! : entry.split(/(?<=\.)\s/)[0]!;
  text = text.replace(/\s+/g, " ").trim().replace(/[.,;:]$/, "");
  if (text.length > 170) text = `${text.slice(0, 167).trimEnd()}…`;
  return outsideCode(text, (plain) =>
    plain
      // A bare `<id>` outside backticks is an unclosed HTML tag to the site's compiler.
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      // `#42` becomes a link to the issue.
      .replace(/(^|[^\w])#(\d+)/g, `$1[#$2](${REPO}/issues/$2)`),
  );
}

/** Apply `fn` to everything except inline code spans, where markdown does not run. */
function outsideCode(text: string, fn: (plain: string) => string): string {
  return text
    .split(/(`[^`]*`)/g)
    .map((part) => (part.startsWith("`") ? part : fn(part)))
    .join("");
}

const lines = readFileSync(SOURCE, "utf8").split("\n");
const out: string[] = [
  "---",
  "title: Release notes",
  "---",
  "",
  "# Release notes",
  "",
  "One line per entry, generated from the repository's",
  `[CHANGELOG.md](${REPO}/blob/main/CHANGELOG.md) at build time — this page is an index, not`,
  "a second copy. Follow the link for the reasoning, the measurements and the code behind any line.",
  "",
  "Releases through 0.3.1 are tagged `alpha`; 0.4.0 is the first `beta`. The commands are real and",
  "tested. See [what alpha, beta and stable mean](/#where-this-is).",
  "",
];

let group: string[] = [];
let heading: string | null = null;

function flush(): void {
  if (!heading) {
    group = [];
    return;
  }
  const entries = bullets(group).map(headline).filter((t) => t.length > 0);
  if (entries.length > 0) {
    out.push(heading, "");
    for (const entry of entries) out.push(`- ${entry}`);
    out.push("");
  }
  group = [];
}

for (const line of lines) {
  if (/^## /.test(line)) {
    flush();
    heading = null;
    const title = line.slice(3).trim();
    out.push(`## ${title}`, "");
  } else if (/^### /.test(line)) {
    flush();
    heading = `### ${line.slice(4).trim()}`;
  } else if (heading) {
    group.push(line);
  }
}
flush();

mkdirSync(dirname(TARGET), { recursive: true });
writeFileSync(TARGET, `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`);
console.log(`gen-changelog: wrote ${TARGET.split("/docs-site/")[1]} from CHANGELOG.md`);
