import { describe, expect, test } from "bun:test";
import { escapeHtml, renderInline, renderMarkdown } from "../src/core/markdown/index.ts";

describe("escapeHtml", () => {
  test("escapes every character that could close a tag or an attribute", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`))
      .toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });
});

describe("renderInline", () => {
  test("code, bold and https links", () => {
    expect(renderInline("read `run.yml` and **stop**"))
      .toBe("read <code>run.yml</code> and <strong>stop</strong>");
    expect(renderInline("[the docs](https://example.com/a)"))
      .toBe('<a href="https://example.com/a">the docs</a>');
    expect(renderInline("[top](#runs)")).toBe('<a href="#runs">top</a>');
  });

  test("markup inside a code span stays literal", () => {
    expect(renderInline("`**not bold** <b>`"))
      .toBe("<code>**not bold** &lt;b&gt;</code>");
  });

  test("a non-https link is left as text rather than becoming an anchor", () => {
    const html = renderInline("[x](http://example.com) [y](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).toContain("[x](http://example.com)");
  });

  test("unclosed markers are not markup", () => {
    expect(renderInline("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(renderInline("a ` b")).toBe("a ` b");
  });
});

describe("renderMarkdown", () => {
  const sample = [
    "# Handoff",
    "",
    "A paragraph with `code`, **bold** and a [link](https://example.com/x).",
    "",
    "## Findings",
    "",
    "- first bullet [src: F007]",
    "- second bullet",
    "",
    "```bash",
    "dotnet build && echo <done>",
    "```",
    "",
    "Trailing paragraph.",
  ].join("\n");

  test("round-trips a sample document", () => {
    expect(renderMarkdown(sample)).toBe([
      "<h1>Handoff</h1>",
      '<p>A paragraph with <code>code</code>, <strong>bold</strong> and a '
        + '<a href="https://example.com/x">link</a>.</p>',
      "<h2>Findings</h2>",
      "<ul><li>first bullet [src: F007]</li><li>second bullet</li></ul>",
      '<pre><code class="language-bash">dotnet build &amp;&amp; echo &lt;done&gt;</code></pre>',
      "<p>Trailing paragraph.</p>",
    ].join("\n"));
  });

  test("is deterministic", () => {
    expect(renderMarkdown(sample)).toBe(renderMarkdown(sample));
  });

  test("consecutive lines join into one paragraph, blank lines separate blocks", () => {
    expect(renderMarkdown("one\ntwo\n\nthree")).toBe("<p>one two</p>\n<p>three</p>");
  });

  test("an unsupported construct survives as text instead of vanishing", () => {
    expect(renderMarkdown("> quoted claim")).toContain("quoted claim");
  });

  test("nothing in the output is unescaped user HTML", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  });
});
