import { assertEquals, assertThrows } from "./_assert.ts";
import { singleStatement, splitStatements } from "../src/lib/sqlscan.ts";

Deno.test("splitStatements: plain statements", () => {
  assertEquals(splitStatements("SELECT 1"), ["SELECT 1"]);
  assertEquals(splitStatements("SELECT 1;"), ["SELECT 1"]);
  assertEquals(splitStatements("SELECT 1; SELECT 2"), ["SELECT 1", "SELECT 2"]);
  assertEquals(splitStatements("  ;;  SELECT 1 ;; "), ["SELECT 1"]);
  assertEquals(splitStatements(""), []);
  assertEquals(splitStatements("   \n\t "), []);
});

Deno.test("splitStatements: comments are not statements", () => {
  assertEquals(splitStatements("-- hello"), []);
  assertEquals(splitStatements("/* block */"), []);
  assertEquals(splitStatements("/* a ; b */ SELECT 1"), [
    "/* a ; b */ SELECT 1",
  ]);
  assertEquals(splitStatements("SELECT 1 -- trailing ; not a split\n"), [
    "SELECT 1 -- trailing ; not a split",
  ]);
  assertEquals(splitStatements("SELECT 1; -- done"), ["SELECT 1"]);
});

Deno.test("splitStatements: quotes protect semicolons", () => {
  assertEquals(splitStatements("SELECT 'a;b'"), ["SELECT 'a;b'"]);
  assertEquals(splitStatements('SELECT "a;b"'), ['SELECT "a;b"']);
  assertEquals(splitStatements("SELECT `a;b`"), ["SELECT `a;b`"]);
  assertEquals(splitStatements("SELECT [a;b]"), ["SELECT [a;b]"]);
  assertEquals(splitStatements("SELECT 'it''s; fine'"), [
    "SELECT 'it''s; fine'",
  ]);
  assertEquals(splitStatements("SELECT 'a;b'; SELECT 'c'"), [
    "SELECT 'a;b'",
    "SELECT 'c'",
  ]);
});

Deno.test("splitStatements: unterminated constructs throw", () => {
  assertThrows(() => splitStatements("SELECT 'oops"), "unterminated");
  assertThrows(() => splitStatements('SELECT "oops'), "unterminated");
  assertThrows(() => splitStatements("SELECT [oops"), "unterminated");
  assertThrows(() => splitStatements("SELECT 1 /* oops"), "unterminated");
});

Deno.test("singleStatement: one statement ok, many rejected", () => {
  assertEquals(singleStatement("SELECT 1"), "SELECT 1");
  assertEquals(
    singleStatement("SELECT 1;"),
    "SELECT 1",
    "trailing semicolon is not a second statement",
  );
  assertThrows(() => singleStatement(""), "empty sql");
  assertThrows(
    () => singleStatement("SELECT 1; SELECT 2"),
    "expected one statement",
  );
});
