import { assertEquals, assertThrows } from "./_assert.ts";
import {
  joinUnder,
  relPathFromString,
  safeRelPath,
} from "../src/lib/pathsafe.ts";

Deno.test("pathsafe: safeRelPath normalizes", () => {
  assertEquals(safeRelPath(["a", "b"]), "a/b");
  assertEquals(safeRelPath(["", "a", "", ".", "b"]), "a/b");
  assertEquals(relPathFromString("./a//b/"), "a/b");
});

Deno.test("pathsafe: traversal and bad characters rejected", () => {
  for (const segs of [[".."], ["a", "..", "b"], ["..", "a"]]) {
    assertThrows(() => safeRelPath(segs), "'..'");
  }
  assertThrows(() => safeRelPath([]), "empty path");
  assertThrows(() => safeRelPath(["", "."]), "empty path");
  assertThrows(() => relPathFromString("a\\b"), "forbidden");
  assertThrows(() => relPathFromString("a\0b"), "forbidden");
});

Deno.test("pathsafe: joinUnder stays inside root", () => {
  assertEquals(joinUnder("/root", "a/b"), "/root/a/b");
  assertThrows(() => joinUnder("/root", "a/../.."), "'..'");
});
