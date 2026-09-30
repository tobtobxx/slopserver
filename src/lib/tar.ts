// Minimal ustar tar reader/writer, for sync uploads and site downloads.
// Only regular files cross the wire; directories are implied. Archives are
// deterministic (mtime 0, mode 0644) so equal content produces equal bytes.

import { ByteReader } from "./binary.ts";
import { SlopError } from "./errors.ts";

export interface TarEntry {
  path: string;
  bytes: Uint8Array;
}

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function writeStr(buf: Uint8Array, off: number, s: string, len: number): void {
  const bytes = encoder.encode(s);
  if (bytes.length > len) {
    throw new SlopError("bad_request", `tar field too long: ${s}`);
  }
  buf.set(bytes, off);
}

function writeOctal(
  buf: Uint8Array,
  off: number,
  len: number,
  value: number,
): void {
  const s = value.toString(8).padStart(len - 1, "0");
  if (s.length > len - 1) {
    throw new SlopError("bad_request", `tar number too big: ${value}`);
  }
  writeStr(buf, off, s, len - 1); // last byte stays NUL
}

// ustar splits long paths into name (<=100) + prefix (<=155) at a '/'.
function splitName(path: string): { name: string; prefix: string } {
  if (encoder.encode(path).length <= 100) return { name: path, prefix: "" };
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const rest = path.slice(i + 1);
    if (
      encoder.encode(prefix).length <= 155 && encoder.encode(rest).length <= 100
    ) {
      return { name: rest, prefix };
    }
  }
  throw new SlopError("bad_request", `tar path too long: ${path}`);
}

function fileHeader(path: string, size: number): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const { name, prefix } = splitName(path);
  writeStr(h, 0, name, 100);
  writeStr(h, 100, "0000644", 8); // mode
  writeStr(h, 108, "0000000", 8); // uid
  writeStr(h, 116, "0000000", 8); // gid
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, 0); // mtime 0: deterministic archives
  h.fill(0x20, 148, 156); // checksum placeholder
  h[156] = 0x30; // typeflag '0' = regular file
  writeStr(h, 257, "ustar", 6); // "ustar\0"
  writeStr(h, 263, "00", 2);
  writeStr(h, 345, prefix, 155);
  let sum = 0;
  for (const b of h) sum += b;
  writeOctal(h, 148, 7, sum); // 6 octal digits + NUL
  h[155] = 0x20;
  return h;
}

function padding(size: number): Uint8Array | null {
  const rem = size % BLOCK;
  return rem === 0 ? null : new Uint8Array(BLOCK - rem);
}

function fromAsyncIterable(
  it: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  const iter = it[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const r = await iter.next();
      if (r.done) controller.close();
      else controller.enqueue(r.value);
    },
    async cancel() {
      await iter.return?.();
    },
  });
}

export function tarStream(
  entries: AsyncIterable<TarEntry>,
): ReadableStream<Uint8Array> {
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for await (const entry of entries) {
      yield fileHeader(entry.path, entry.bytes.length);
      yield entry.bytes;
      const pad = padding(entry.bytes.length);
      if (pad) yield pad;
    }
    yield new Uint8Array(BLOCK * 2); // end-of-archive
  }
  return fromAsyncIterable(chunks());
}

function parseOctal(buf: Uint8Array, off: number, len: number): number {
  const s = decoder.decode(buf.subarray(off, off + len)).replace(/[\0 ]+$/, "")
    .trim();
  if (s === "") return 0;
  const v = parseInt(s, 8);
  if (Number.isNaN(v)) {
    throw new SlopError(
      "bad_request",
      `corrupt tar: bad number ${JSON.stringify(s)}`,
    );
  }
  return v;
}

function readStr(buf: Uint8Array, off: number, len: number): string {
  const slice = buf.subarray(off, off + len);
  const nul = slice.indexOf(0);
  return decoder.decode(nul === -1 ? slice : slice.subarray(0, nul));
}

function verifyChecksum(h: Uint8Array): void {
  const stored = parseOctal(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  if (sum !== stored) {
    throw new SlopError(
      "bad_request",
      `corrupt tar: checksum mismatch (${sum} != ${stored})`,
    );
  }
}

// Yields regular files. Directory, pax and link entries are consumed and
// skipped; GNU 'L' long names are honored.
export async function* readTar(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<TarEntry> {
  const r = new ByteReader(stream);
  let longName: string | null = null;
  while (true) {
    const head = await r.readExact(BLOCK);
    if (head === null) return;
    if (head.every((b) => b === 0)) return; // end-of-archive
    verifyChecksum(head);
    const size = parseOctal(head, 124, 12);
    const type = String.fromCharCode(head[156]);
    let name = readStr(head, 0, 100);
    const prefix = readStr(head, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    if (longName) {
      name = longName;
      longName = null;
    }
    const body = (await r.readExact(size)) ?? new Uint8Array(0);
    const pad = padding(size);
    if (pad) await r.skip(pad.length);
    if (type === "L") {
      longName = decoder.decode(body).replace(/\0+$/, "");
      continue;
    }
    if (type === "0" || type === "\0" || type === "7") {
      yield { path: name, bytes: body };
    }
  }
}
