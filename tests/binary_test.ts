import { assertEquals, assertRejects, assertThrows } from "./_assert.ts";
import { ByteReader } from "../src/lib/binary.ts";

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

Deno.test("ByteReader: reads across chunk boundaries", async () => {
  const r = new ByteReader(streamOf(new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])));
  assertEquals(Array.from((await r.readExact(3))!), [1, 2, 3]);
  assertEquals(Array.from((await r.readExact(2))!), [4, 5]);
  assertEquals(await r.readExact(1), null, "clean EOF gives null");
});

Deno.test("ByteReader: skip and zero-length reads", async () => {
  const r = new ByteReader(streamOf(new Uint8Array([1, 2, 3, 4])));
  assertEquals((await r.readExact(0))!.length, 0);
  await r.skip(2);
  assertEquals(Array.from((await r.readExact(2))!), [3, 4]);
});

Deno.test("ByteReader: truncated stream throws", async () => {
  const r = new ByteReader(streamOf(new Uint8Array([1])));
  await assertRejects(() => r.readExact(4), "unexpected end of stream");
});
