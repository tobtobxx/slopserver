import { assertEquals } from "./_assert.ts";
import { sha256Hex, sha256HexFile } from "../src/lib/hash.ts";

const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

Deno.test("sha256 of bytes", async () => {
  assertEquals(await sha256Hex(new Uint8Array()), EMPTY);
  assertEquals(await sha256Hex(new TextEncoder().encode("abc")), ABC);
});

Deno.test("sha256 of file, including a file bigger than the read buffer", async () => {
  const dir = Deno.makeTempDirSync();
  await Deno.writeTextFile(`${dir}/a`, "abc");
  assertEquals(await sha256HexFile(`${dir}/a`), ABC);
  const big = new Uint8Array(200_000).fill(65);
  await Deno.writeFile(`${dir}/big`, big);
  assertEquals(await sha256HexFile(`${dir}/big`), await sha256Hex(big));
});
