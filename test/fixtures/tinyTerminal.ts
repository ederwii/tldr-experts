/**
 * A terminal, in as much detail as the driver's output needs and no more.
 *
 * The driver writes cursor-ups, clear-lines and newlines rather than repainting,
 * which is the whole reason it is cheap — and also the whole reason it could be
 * subtly wrong in a way no assertion on the escape STRING would catch. So the
 * tests replay that string through this and compare the resulting SCREEN with
 * the frame `render` says it should be showing.
 *
 * Understood: `\x1b[?25l`, `\x1b[?25h`, `\x1b[<n>A`, `\x1b[2K`, `\x1b[J`, `\r`,
 * `\n`. Anything else is a test failure by way of a thrown error — a driver that
 * started emitting a sequence this does not model must not pass quietly.
 */
export class TinyTerminal {
  private readonly rows: string[] = [""];
  private row = 0;
  private col = 0;
  cursorVisible = true;

  write(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i] ?? "";
      if (ch === "\x1b") {
        i = this.escape(text, i);
        continue;
      }
      if (ch === "\n") { this.newline(); continue; }
      if (ch === "\r") { this.col = 0; continue; }
      this.put(ch);
    }
  }

  /** The screen, trailing blank rows dropped. */
  screen(): readonly string[] {
    const out = this.rows.map((line) => line.replace(/\s+$/, ""));
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    return out;
  }

  private escape(text: string, at: number): number {
    const rest = text.slice(at);
    const match = /^\x1b\[(\?25[lh]|\d*[AKJ])/.exec(rest);
    if (match === null) throw new Error(`TinyTerminal: unmodelled escape at ${JSON.stringify(rest.slice(0, 12))}`);
    const code = match[1] ?? "";
    if (code === "?25l") this.cursorVisible = false;
    else if (code === "?25h") this.cursorVisible = true;
    else if (code.endsWith("A")) this.row = Math.max(0, this.row - (Number(code.slice(0, -1)) || 1));
    else if (code === "2K") this.setRow(this.row, "");
    else if (code === "J") {
      // ED 0: from the cursor to the end of the display — the REST OF THIS ROW
      // included, which is what makes the driver's erase-then-repaint correct.
      this.setRow(this.row, (this.rows[this.row] ?? "").slice(0, this.col));
      this.rows.length = this.row + 1;
    }
    else throw new Error(`TinyTerminal: unmodelled escape ${code}`);
    return at + match[0].length - 1;
  }

  private newline(): void {
    this.row += 1;
    this.col = 0;
    while (this.rows.length <= this.row) this.rows.push("");
  }

  private put(ch: string): void {
    const line = this.rows[this.row] ?? "";
    const padded = line.length < this.col ? line + " ".repeat(this.col - line.length) : line;
    this.setRow(this.row, padded.slice(0, this.col) + ch + padded.slice(this.col + 1));
    this.col += 1;
  }

  private setRow(index: number, value: string): void {
    while (this.rows.length <= index) this.rows.push("");
    this.rows[index] = value;
  }
}
