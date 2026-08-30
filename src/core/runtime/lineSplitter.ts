/**
 * Turning a byte stream into whole lines, for `SpawnOptions.onStdoutLine`.
 *
 * A chunk boundary is not a line boundary: `claude --output-format stream-json`
 * emits JSONL where one event is routinely 6 KB, so a naive "split each chunk on
 * \n" hands the parser two halves of an object and loses it. This holds the tail
 * until its newline arrives.
 *
 * `\r\n` is normalised, because a Windows child would otherwise leave a carriage
 * return glued to the end of every line and `JSON.parse` tolerates that only by
 * accident.
 */
export class LineSplitter {
  private buffer = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.emit(line);
      index = this.buffer.indexOf("\n");
    }
  }

  /** Flush whatever has no newline after it — a producer's last line. */
  end(): void {
    const rest = this.buffer;
    this.buffer = "";
    if (rest !== "") this.emit(rest);
  }

  private emit(line: string): void {
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (clean !== "") this.onLine(clean);
  }
}
