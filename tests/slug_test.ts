import { assertEquals, assertThrows } from "./_assert.ts";
import { assertValidSlug, isValidSlug } from "../src/lib/slug.ts";

Deno.test("slugs: valid", () => {
  for (
    const slug of ["a", "x", "project-x", "a1", "0", "a-b-c", "x".repeat(63)]
  ) {
    assertEquals(isValidSlug(slug), true, slug);
  }
});

Deno.test("slugs: invalid", () => {
  for (
    const slug of [
      "",
      "-x",
      "A",
      "a_b",
      "a b",
      "a/b",
      "a.b",
      "x".repeat(64),
      "ä",
      "api",
    ]
  ) {
    assertEquals(isValidSlug(slug), false, slug);
  }
});

Deno.test("slugs: error kinds", () => {
  assertEquals(
    (assertThrows(() => assertValidSlug("nope/x")) as { code: string }).code,
    "invalid_slug",
  );
  assertEquals(
    (assertThrows(() => assertValidSlug("api")) as { code: string }).code,
    "reserved_slug",
  );
});
