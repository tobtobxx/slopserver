import { assertEquals, assertThrows } from "./_assert.ts";
import { Registry } from "../src/lib/registry.ts";

function newRegistry(): Registry {
  const dir = Deno.makeTempDirSync();
  return new Registry(`${dir}/slopserver.db`);
}

Deno.test("registry: create, list, get, delete projects", () => {
  const reg = newRegistry();
  reg.createProject("alpha", "first project");
  reg.createProject("beta", "");
  assertEquals(reg.listProjects().map((p) => p.slug), ["alpha", "beta"]);
  assertEquals(reg.getProject("alpha")?.description, "first project");
  assertEquals(reg.getProject("nope"), null);

  const e = assertThrows(() => reg.createProject("alpha", "")) as { code: string };
  assertEquals(e.code, "project_exists");
  assertEquals((assertThrows(() => reg.createProject("api", "")) as { code: string }).code, "reserved_slug");

  reg.deleteProject("alpha");
  assertEquals(reg.listProjects().map((p) => p.slug), ["beta"]);
  reg.close();
});

Deno.test("registry: manifest replace is transactional", () => {
  const reg = newRegistry();
  reg.createProject("alpha", "");
  reg.setManifest("alpha", new Map([
    ["index.html", { hash: "aa", size: 10 }],
    ["app.js", { hash: "bb", size: 20 }],
  ]));
  assertEquals(reg.getManifest("alpha"), new Map([
    ["index.html", { hash: "aa", size: 10 }],
    ["app.js", { hash: "bb", size: 20 }],
  ]));
  reg.setManifest("alpha", new Map([["app.js", { hash: "cc", size: 25 }]]));
  assertEquals(reg.getManifest("alpha"), new Map([["app.js", { hash: "cc", size: 25 }]]));
  reg.close();
});

Deno.test("registry: usage counters", () => {
  const reg = newRegistry();
  reg.createProject("alpha", "");
  reg.setManifest("alpha", new Map([["a", { hash: "aa", size: 100 }]]));
  reg.incrementRequests("alpha");
  reg.incrementRequests("alpha", 4);
  reg.incrementRequests("beta");
  assertEquals(reg.getUsage("alpha"), { site_bytes: 100, requests: 5 });
  assertEquals(reg.getUsage("beta"), { site_bytes: 0, requests: 1 });
  reg.close();
});

Deno.test("registry: deleteProject removes manifest and counters", () => {
  const reg = newRegistry();
  reg.createProject("alpha", "");
  reg.setManifest("alpha", new Map([["a", { hash: "aa", size: 1 }]]));
  reg.incrementRequests("alpha");
  reg.deleteProject("alpha");
  assertEquals(reg.getManifest("alpha"), new Map());
  assertEquals(reg.getUsage("alpha"), { site_bytes: 0, requests: 0 });
  reg.close();
});
