import { assertEquals, assertRejects } from "./_assert.ts";
import { gunzipStream, gzipBytes, gunzipBytes } from "../src/lib/gzip.ts";
import { readTar, tarStream, type TarEntry } from "../src/lib/tar.ts";

function streamOfBytes(bytes: Uint8Array, chunkSize = 7): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.subarray(i, i + chunkSize));
      c.close();
    },
  });
}

async function* entriesOf(entries: TarEntry[]): AsyncGenerator<TarEntry> {
  for (const e of entries) yield e;
}

async function tarBytes(entries: TarEntry[]): Promise<Uint8Array> {
  return new Uint8Array(await new Response(tarStream(entriesOf(entries))).arrayBuffer());
}

async function readAll(tar: ReadableStream<Uint8Array>): Promise<TarEntry[]> {
  const out: TarEntry[] = [];
  for await (const e of readTar(tar)) out.push({ path: e.path, bytes: e.bytes });
  return out;
}

function simplify(entries: TarEntry[]) {
  return entries.map((e) => ({ path: e.path, bytes: Array.from(e.bytes) }));
}

const SAMPLE: TarEntry[] = [
  { path: "index.html", bytes: new TextEncoder().encode("<h1>hi</h1>") },
  { path: "empty.txt", bytes: new Uint8Array(0) },
  { path: "dir/data.bin", bytes: new Uint8Array([0, 1, 2, 255]) },
  { path: "unicode/ä.txt", bytes: new TextEncoder().encode("ö") },
];

Deno.test("tar: round trip", async () => {
  assertEquals(simplify(await readAll(tarStream(entriesOf(SAMPLE)))), simplify(SAMPLE));
});

Deno.test("tar: deterministic bytes", async () => {
  const a = await tarBytes(SAMPLE);
  const b = await tarBytes(SAMPLE);
  assertEquals(Array.from(a), Array.from(b));
});

Deno.test("tar: paths longer than 100 bytes split into prefix", async () => {
  const long = `${"d".repeat(80)}/${"f".repeat(60)}.txt`;
  const got = await readAll(tarStream(entriesOf([{ path: long, bytes: new Uint8Array([9]) }])));
  assertEquals(got[0].path, long);
});

Deno.test("tar: unsplittable long path rejected", async () => {
  const bad = "x".repeat(101);
  await assertRejects(async () => {
    await tarBytes([{ path: bad, bytes: new Uint8Array(0) }]);
  }, "too long");
});

Deno.test("tar: empty archive yields no entries", async () => {
  assertEquals(await readAll(tarStream(entriesOf([]))), []);
});

Deno.test("tar: corrupt checksum rejected", async () => {
  const bytes = await tarBytes(SAMPLE);
  bytes[0] = 0x78; // smash the file name, invalidating the checksum
  await assertRejects(async () => {
    await readAll(streamOfBytes(bytes));
  }, "checksum");
});

Deno.test("tar: truncated archive rejected", async () => {
  const bytes = await tarBytes(SAMPLE);
  await assertRejects(async () => {
    await readAll(streamOfBytes(bytes.subarray(0, bytes.length - 600)));
  }, "unexpected end of stream");
});

Deno.test("tar through gzip round trip", async () => {
  const gz = await gzipBytes(await tarBytes(SAMPLE));
  const back = await gunzipBytes(gz);
  assertEquals(simplify(await readAll(streamOfBytes(back))), simplify(SAMPLE));
  const stream = gunzipStream(streamOfBytes(gz));
  assertEquals(simplify(await readAll(stream)), simplify(SAMPLE));
  assertEquals(await gunzipStream(streamOfBytes(gz)) instanceof ReadableStream, true);
});
