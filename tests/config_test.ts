import { assertEquals, assertThrows } from "./_assert.ts";
import { appendEnvKeys, loadEnvFile, parseEnv } from "../src/lib/envfile.ts";

Deno.test("parseEnv: basics", () => {
  const m = parseEnv([
    "# comment",
    "",
    "A=1",
    "export B=2",
    "C='quoted value'",
    'D="dq # not comment"',
    "E=",
    "not a var line",
    "F=last wins",
    "F=override",
  ].join("\n"));
  assertEquals(m.get("A"), "1");
  assertEquals(m.get("B"), "2");
  assertEquals(m.get("C"), "quoted value");
  assertEquals(m.get("D"), "dq # not comment");
  assertEquals(m.get("E"), "");
  assertEquals(m.has("not"), false);
  assertEquals(m.get("F"), "override");
});

Deno.test("loadEnvFile: missing file ok, existing env wins", () => {
  const dir = Deno.makeTempDirSync();
  loadEnvFile(`${dir}/missing.env`); // no throw
  Deno.env.set("SLOPTEST_SET", "from-env");
  Deno.env.delete("SLOPTEST_UNSET");
  Deno.writeTextFileSync(`${dir}/.env`, "SLOPTEST_SET=from-file\nSLOPTEST_UNSET=from-file\n");
  loadEnvFile(`${dir}/.env`);
  assertEquals(Deno.env.get("SLOPTEST_SET"), "from-env");
  assertEquals(Deno.env.get("SLOPTEST_UNSET"), "from-file");
  Deno.env.delete("SLOPTEST_SET");
  Deno.env.delete("SLOPTEST_UNSET");
});

Deno.test("appendEnvKeys: creates, appends, skips existing", () => {
  const dir = Deno.makeTempDirSync();
  const path = `${dir}/.env`;
  assertEquals(appendEnvKeys(path, { A: "1", B: "x y" }), ["A", "B"]);
  assertEquals(appendEnvKeys(path, { A: "2", C: "3" }), ["C"]);
  const text = Deno.readTextFileSync(path);
  assertEquals(text, 'A=1\nB="x y"\nC=3\n');
  assertEquals(parseEnv(text).get("A"), "1", "existing entry is not touched");
});

Deno.test("appendEnvKeys: file without trailing newline", () => {
  const dir = Deno.makeTempDirSync();
  const path = `${dir}/.env`;
  Deno.writeTextFileSync(path, "A=1");
  appendEnvKeys(path, { B: "2" });
  assertEquals(Deno.readTextFileSync(path), "A=1\nB=2\n");
});

Deno.test("resolveUrl and resolveSlug precedence", async () => {
  const { resolveSlug, resolveUrl, DEFAULT_URL } = await import("../src/lib/config.ts");
  Deno.env.delete("SLOPSERVER_URL");
  Deno.env.delete("SLOPSERVER_SLUG");
  assertEquals(resolveUrl(), DEFAULT_URL);
  assertEquals(resolveUrl("https://x.example/"), "https://x.example", "trailing slash stripped");
  Deno.env.set("SLOPSERVER_URL", "https://env.example");
  assertEquals(resolveUrl("https://flag.example"), "https://flag.example");
  assertEquals(resolveUrl(), "https://env.example");
  assertThrows(() => resolveSlug(), "no slug");
  Deno.env.set("SLOPSERVER_SLUG", "env-slug");
  assertEquals(resolveSlug(), "env-slug");
  assertEquals(resolveSlug("flag-slug"), "flag-slug");
  Deno.env.delete("SLOPSERVER_URL");
  Deno.env.delete("SLOPSERVER_SLUG");
});
