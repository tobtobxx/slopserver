import { assertEquals, assertRejects } from "./_assert.ts";
import { gzipBytes, gunzipBytes, gzipStream } from "../src/lib/gzip.ts";
import { siteEntries, siteTarGz, syncSite, SYNC_META_ENTRY } from "../src/lib/site.ts";
import type { FileMeta } from "../src/lib/registry.ts";
import { readTar, tarStream, type TarEntry } from "../src/lib/tar.ts";
import { sha256Hex } from "../src/lib/hash.ts";

function tmpDirs() {
  const root = Deno.makeTempDirSync();
  return { siteDir: `${root}/site`, stagingDir: `${root}/staging`, root };
}

function tarGzBody(files: Record<string, string>, meta?: unknown): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  async function* gen(): AsyncGenerator<TarEntry> {
    if (meta !== undefined) yield { path: SYNC_META_ENTRY, bytes: enc.encode(JSON.stringify(meta)) };
    for (const [path, content] of Object.entries(files)) yield { path, bytes: enc.encode(content) };
  }
  return gzipStream(tarStream(gen()));
}

async function hashOf(content: string): Promise<FileMeta> {
  return { hash: await sha256Hex(new TextEncoder().encode(content)), size: content.length };
}

async function readSite(siteDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const e of siteEntries(siteDir)) out[e.path] = new TextDecoder().decode(e.bytes);
  return out;
}

function assertGone(path: string): void {
  try {
    Deno.statSync(path);
    throw new Error(`expected ${path} to be gone`);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return;
    throw e;
  }
}

Deno.test("syncSite: initial upload places files and builds the manifest", async () => {
  const { siteDir, stagingDir } = tmpDirs();
  await Deno.mkdir(siteDir, { recursive: true });
  const { manifest, result } = await syncSite({
    siteDir,
    stagingDir,
    body: tarGzBody({ "index.html": "hello", "a/b.txt": "nested" }, { delete: [] }),
    manifest: new Map(),
  });
  assertEquals(await readSite(siteDir), { "index.html": "hello", "a/b.txt": "nested" });
  assertEquals([...manifest.keys()].sort(), ["a/b.txt", "index.html"]);
  assertEquals(manifest.get("index.html"), await hashOf("hello"));
  assertEquals(result.put, ["a/b.txt", "index.html"]);
  assertEquals(result.deleted, []);
  assertEquals(result.unchanged, 0);
});

Deno.test("syncSite: delta upload keeps unchanged files, applies deletes", async () => {
  const { siteDir, stagingDir } = tmpDirs();
  await Deno.mkdir(siteDir, { recursive: true });
  const first = await syncSite({
    siteDir,
    stagingDir,
    body: tarGzBody({ "index.html": "hello", "old.css": "gone soon", "app.js": "v1" }),
    manifest: new Map(),
  });
  const second = await syncSite({
    siteDir,
    stagingDir: `${stagingDir}-2`,
    body: tarGzBody({ "app.js": "v2", "new.png": "img" }, { delete: ["old.css"] }),
    manifest: first.manifest,
  });
  assertEquals(await readSite(siteDir), { "index.html": "hello", "app.js": "v2", "new.png": "img" });
  assertEquals(second.result.put, ["app.js", "new.png"]);
  assertEquals(second.result.deleted, ["old.css"]);
  assertEquals(second.result.unchanged, 1, "index.html carried over");
  assertEquals(second.manifest.get("index.html"), await hashOf("hello"));
  assertEquals(second.manifest.get("app.js"), await hashOf("v2"));
});

Deno.test("syncSite: manifest records sizes and drift drops missing files", async () => {
  const { siteDir, stagingDir } = tmpDirs();
  await Deno.mkdir(siteDir, { recursive: true });
  await Deno.writeTextFile(`${siteDir}/real.txt`, "real");
  const { manifest, result } = await syncSite({
    siteDir,
    stagingDir,
    body: tarGzBody({ "f.txt": "0123456789" }),
    manifest: new Map([
      ["real.txt", await hashOf("real")],
      ["ghost.txt", await hashOf("ghost")],
    ]),
  });
  assertEquals(manifest.get("real.txt"), await hashOf("real"));
  assertEquals(manifest.get("f.txt"), await hashOf("0123456789"));
  assertEquals([...manifest.keys()].sort(), ["f.txt", "real.txt"]);
  assertEquals(result.unchanged, 1);
});

Deno.test("syncSite: rejects traversal and put/delete overlap, leaves site alone", async () => {
  const { siteDir, stagingDir } = tmpDirs();
  await Deno.mkdir(siteDir, { recursive: true });
  await Deno.writeTextFile(`${siteDir}/keep.txt`, "keep");
  await assertRejects(() =>
    syncSite({
      siteDir,
      stagingDir,
      body: tarGzBody({ "x": "data" }, { delete: ["../escape"] }),
      manifest: new Map(),
    }), "'..'");
  await assertRejects(() =>
    syncSite({
      siteDir,
      stagingDir: `${stagingDir}-2`,
      body: tarGzBody({ "x": "data" }, { delete: ["x"] }),
      manifest: new Map(),
    }), "both uploaded and deleted");
  assertEquals(await readSite(siteDir), { "keep.txt": "keep" });
  assertGone(stagingDir);
  assertGone(`${stagingDir}-2`);
});

Deno.test("syncSite: corrupt upload body is rejected and staging cleaned up", async () => {
  const { siteDir, stagingDir } = tmpDirs();
  await Deno.mkdir(siteDir, { recursive: true });
  await assertRejects(() =>
    syncSite({
      siteDir,
      stagingDir,
      body: new Blob([new Uint8Array([1, 2, 3])]).stream(),
      manifest: new Map(),
    })
  );
  assertGone(stagingDir);
});

Deno.test("siteTarGz: export mirrors the site directory", async () => {
  const { siteDir } = tmpDirs();
  await Deno.mkdir(`${siteDir}/sub`, { recursive: true });
  await Deno.writeTextFile(`${siteDir}/index.html`, "hello");
  await Deno.writeTextFile(`${siteDir}/sub/x.txt`, "nested");
  const tar = await gunzipBytes(new Uint8Array(await new Response(siteTarGz(siteDir)).arrayBuffer()));
  const got: Record<string, string> = {};
  for await (const e of readTar(new Blob([tar as BlobPart]).stream())) {
    got[e.path] = new TextDecoder().decode(e.bytes);
  }
  assertEquals(got, { "index.html": "hello", "sub/x.txt": "nested" });
});

Deno.test("gzipBytes round trip", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  assertEquals(Array.from(await gunzipBytes(await gzipBytes(bytes))), Array.from(bytes));
});
