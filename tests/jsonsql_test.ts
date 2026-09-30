import { assertEquals, assertThrows } from "./_assert.ts";
import { bindValue, encodeValue, fromBase64, toBase64 } from "../src/lib/jsonsql.ts";

Deno.test("base64 round trip", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  assertEquals(Array.from(fromBase64(toBase64(bytes))), Array.from(bytes));
  assertEquals(toBase64(new Uint8Array([])), "");
  assertEquals(fromBase64(""), new Uint8Array([]));
});

Deno.test("base64: invalid input throws", () => {
  assertThrows(() => fromBase64("!!!!"), "invalid base64");
});

Deno.test("bindValue: scalars", () => {
  assertEquals(bindValue(null), null);
  assertEquals(bindValue(true), 1n);
  assertEquals(bindValue(false), 0n);
  assertEquals(bindValue(5), 5n, "integer-valued numbers bind as INTEGER");
  assertEquals(bindValue(5.5), 5.5);
  assertEquals(bindValue(2 ** 53), 2 ** 53, "beyond safe integers stays REAL");
  assertEquals(bindValue("x"), "x");
});

Deno.test("bindValue: blobs and rejects", () => {
  assertEquals(Array.from(bindValue({ blob: "AAEC" }) as Uint8Array), [0, 1, 2]);
  assertThrows(() => bindValue([1, 2] as never), "cannot bind");
  assertThrows(() => bindValue({ a: 1 } as never), "cannot bind");
  assertThrows(() => bindValue({ blob: 5 } as never), "cannot bind");
});

Deno.test("encodeValue: scalars and big ints", () => {
  assertEquals(encodeValue(null), null);
  assertEquals(encodeValue(5.5), 5.5);
  assertEquals(encodeValue("x"), "x");
  assertEquals(encodeValue(5n), 5);
  assertEquals(encodeValue(9007199254740993n), "9007199254740993", "unsafe integers become strings");
  assertEquals(encodeValue(-9007199254740993n), "-9007199254740993");
  assertEquals(encodeValue(new Uint8Array([1, 2])), { blob: "AQI=" });
});
