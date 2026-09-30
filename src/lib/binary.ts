// Byte-oriented reading over a ReadableStream, for tar parsing.

export class ByteReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buf = new Uint8Array(0);
  #eof = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async #fill(n: number): Promise<void> {
    while (this.#buf.length < n && !this.#eof) {
      const { value, done } = await this.#reader.read();
      if (done) {
        this.#eof = true;
        break;
      }
      const next = new Uint8Array(this.#buf.length + value.length);
      next.set(this.#buf);
      next.set(value, this.#buf.length);
      this.#buf = next;
    }
  }

  // Returns null on clean EOF (before any byte of this record).
  async readExact(n: number): Promise<Uint8Array | null> {
    if (n === 0) return new Uint8Array(0);
    await this.#fill(n);
    if (this.#buf.length === 0) return null;
    if (this.#buf.length < n) {
      throw new Error(
        `unexpected end of stream (wanted ${n} bytes, got ${this.#buf.length})`,
      );
    }
    const out = this.#buf.subarray(0, n);
    this.#buf = this.#buf.subarray(n);
    return out.slice();
  }

  async skip(n: number): Promise<void> {
    while (n > 0) {
      const chunk = await this.readExact(Math.min(n, 1 << 16));
      if (chunk === null) {
        throw new Error("unexpected end of stream while skipping");
      }
      n -= chunk.length;
    }
  }
}
