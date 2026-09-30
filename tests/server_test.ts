import { assertEquals } from "./_assert.ts";
import { startHost } from "../src/host/server.ts";
import { gzipBytes } from "../src/lib/gzip.ts";
import { type TarEntry, tarStream } from "../src/lib/tar.ts";
import { SYNC_META_ENTRY } from "../src/lib/site.ts";

async function withHost(fn: (url: string) => Promise<void>): Promise<void> {
  const data = Deno.makeTempDirSync();
  const host = await startHost({ data, host: "127.0.0.1", port: 0 });
  try {
    await fn(host.url);
  } finally {
    await host.stop();
  }
}

async function api(url: string, method: string, path: string, body?: unknown) {
  const res = await fetch(url + path, {
    method,
    headers: body !== undefined
      ? { "content-type": "application/json" }
      : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    headers: res.headers,
  };
}

async function syncBody(
  files: Record<string, string>,
  meta?: unknown,
): Promise<Blob> {
  async function* gen(): AsyncGenerator<TarEntry> {
    if (meta !== undefined) {
      yield {
        path: SYNC_META_ENTRY,
        bytes: new TextEncoder().encode(JSON.stringify(meta)),
      };
    }
    for (const [path, content] of Object.entries(files)) {
      yield { path, bytes: new TextEncoder().encode(content) };
    }
  }
  const tar = new Uint8Array(
    await new Response(tarStream(gen())).arrayBuffer(),
  );
  return new Blob([await gzipBytes(tar) as BlobPart]);
}

function createProject(url: string, slug: string, description?: string) {
  return api(url, "POST", "/api/", { slug, description });
}

Deno.test("server: create, list and delete projects", async () => {
  await withHost(async (url) => {
    const created = await createProject(url, "demo", "a <b>demo</b> & co");
    assertEquals(created.status, 201);
    assertEquals(created.body.project.slug, "demo");
    assertEquals(created.body.project.description, "a <b>demo</b> & co");
    assertEquals(typeof created.body.project.created_at, "string");

    const dup = await createProject(url, "demo");
    assertEquals(dup.status, 409);
    assertEquals(dup.body.error.code, "project_exists");

    const bad = await createProject(url, "nope/../x");
    assertEquals(bad.status, 400);
    assertEquals(bad.body.error.code, "invalid_slug");

    const reserved = await createProject(url, "api");
    assertEquals(reserved.status, 400);
    assertEquals(reserved.body.error.code, "reserved_slug");

    const missing = await api(url, "POST", "/api/", { description: "no slug" });
    assertEquals(missing.status, 400);

    const list = await api(url, "GET", "/api/");
    assertEquals(list.status, 200);
    assertEquals(list.body.projects.map((p: { slug: string }) => p.slug), [
      "demo",
    ]);
    assertEquals(
      list.body.projects[0].db_bytes > 0,
      true,
      "empty db exists after create",
    );

    const gone = await api(url, "DELETE", "/api/demo");
    assertEquals(gone.status, 200);
    assertEquals((await api(url, "GET", "/api/")).body.projects, []);
  });
});

Deno.test("server: data plane query/exec/batch/schema", async () => {
  await withHost(async (url) => {
    await createProject(url, "demo");
    const exec = await api(url, "POST", "/api/demo/exec", {
      sql:
        "CREATE TABLE todos (id INTEGER PRIMARY KEY, text TEXT, done BOOLEAN)",
    });
    assertEquals(exec.status, 200);

    const insert = await api(url, "POST", "/api/demo/exec", {
      sql: "INSERT INTO todos (text, done) VALUES (:text, :done)",
      params: { text: "write slop", done: false },
    });
    assertEquals(insert.body, { changes: 1, last_insert_rowid: 1 });

    const query = await api(url, "POST", "/api/demo/query", {
      sql: "SELECT id, text, done FROM todos WHERE done = ?",
      params: [0],
    });
    assertEquals(query.body, {
      columns: ["id", "text", "done"],
      rows: [{ id: 1, text: "write slop", done: 0 }],
    });

    const batch = await api(url, "POST", "/api/demo/batch", [
      { sql: "UPDATE todos SET done = ? WHERE id = ?", params: [true, 1] },
      {
        sql: "SELECT count(*) AS open FROM todos WHERE done = ?",
        params: [false],
      },
    ]);
    assertEquals(batch.body.results, [
      { changes: 1, last_insert_rowid: 1 },
      { columns: ["open"], rows: [{ open: 0 }] },
    ]);

    const schema = await api(url, "GET", "/api/demo/schema");
    assertEquals(schema.body.tables.map((t: { name: string }) => t.name), [
      "todos",
    ]);

    const sqlErr = await api(url, "POST", "/api/demo/query", {
      sql: "SELECT * FROM missing",
    });
    assertEquals(sqlErr.status, 400);
    assertEquals(sqlErr.body.error.code, "sql_error");

    const multi = await api(url, "POST", "/api/demo/query", {
      sql: "SELECT 1; SELECT 2",
    });
    assertEquals(multi.status, 400);
    assertEquals(multi.body.error.code, "bad_request");

    const wrongMethod = await api(url, "GET", "/api/demo/query");
    assertEquals(wrongMethod.status, 405);

    const noProject = await api(url, "POST", "/api/ghost/query", {
      sql: "SELECT 1",
    });
    assertEquals(noProject.status, 404);
    assertEquals(noProject.body.error.code, "project_not_found");
  });
});

Deno.test("server: blob values round trip over the api", async () => {
  await withHost(async (url) => {
    await createProject(url, "demo");
    await api(url, "POST", "/api/demo/exec", {
      sql: "CREATE TABLE b (data BLOB)",
    });
    await api(url, "POST", "/api/demo/exec", {
      sql: "INSERT INTO b VALUES (?)",
      params: [{ blob: "AQI=" }],
    });
    const q = await api(url, "POST", "/api/demo/query", {
      sql: "SELECT data FROM b",
    });
    assertEquals(q.body.rows, [{ data: { blob: "AQI=" } }]);
  });
});

Deno.test("server: static files, redirects and 404", async () => {
  await withHost(async (url) => {
    await createProject(url, "demo");
    const body = await syncBody({
      "index.html": "<h1>hi</h1>",
      "app.js": "console.log(1)",
      "sub/page.html": "<p>sub</p>",
      "sub/keep.txt": "text",
    }, { delete: [] });
    const sync = await fetch(`${url}/api/demo/sync`, { method: "POST", body });
    assertEquals(sync.status, 200);

    const index = await fetch(`${url}/demo/`);
    assertEquals(index.status, 200);
    assertEquals(index.headers.get("content-type"), "text/html; charset=utf-8");
    assertEquals(await index.text(), "<h1>hi</h1>");

    const js = await fetch(`${url}/demo/app.js`);
    assertEquals(
      js.headers.get("content-type"),
      "text/javascript; charset=utf-8",
    );

    const redirected = await fetch(`${url}/demo`, { redirect: "manual" });
    assertEquals(redirected.status, 301);
    assertEquals(redirected.headers.get("location"), "/demo/");

    const dirRedirect = await fetch(`${url}/demo/sub`, { redirect: "manual" });
    assertEquals(dirRedirect.status, 301);
    assertEquals(dirRedirect.headers.get("location"), "/demo/sub/");

    const sub = await fetch(`${url}/demo/sub/`);
    assertEquals(sub.status, 404, "no index.html in sub/");

    const notFound = await fetch(`${url}/demo/missing.html`);
    assertEquals(notFound.status, 404);
    assertEquals((await notFound.json()).error.code, "not_found");

    const etag = js.headers.get("etag");
    const cached = await fetch(`${url}/demo/app.js`, {
      headers: { "if-none-match": etag! },
    });
    assertEquals(cached.status, 304);

    // fetch's URL parser collapses %2e%2e before the request goes out; what
    // arrives is /slopserver.db, which fails the slug check.
    const normalized = await fetch(`${url}/demo/%2e%2e/slopserver.db`);
    assertEquals(normalized.status, 404);
    assertEquals((await normalized.json()).error.code, "not_found");

    // A raw client can send literal ..; deno.serve collapses dot segments
    // before routing and the slug check kills the rest. The invariant is that
    // nothing outside the site directory is ever served (path safety itself
    // lives in pathsafe.ts, exercised in pathsafe_test).
    const { hostname, port } = new URL(url);
    const conn = await Deno.connect({ hostname, port: Number(port) });
    await conn.write(
      new TextEncoder().encode(
        "GET /demo/../slopserver.db HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
      ),
    );
    const buf = new Uint8Array(2048);
    const n = (await conn.read(buf)) ?? 0;
    conn.close();
    const raw = new TextDecoder().decode(buf.subarray(0, n));
    assertEquals(
      raw.includes("SQLite format"),
      false,
      `literal .. must not serve db: ${raw}`,
    );
    assertEquals(raw.includes("404"), true, raw);

    const unknownProject = await fetch(`${url}/ghost/`);
    assertEquals(unknownProject.status, 404);
    assertEquals((await unknownProject.json()).error.code, "project_not_found");
  });
});

Deno.test("server: sync, manifest and downloads", async () => {
  await withHost(async (url) => {
    await createProject(url, "demo");
    const first = await fetch(`${url}/api/demo/sync`, {
      method: "POST",
      body: await syncBody({ "index.html": "hello", "old.css": "x" }, {
        delete: [],
      }),
    });
    assertEquals(first.status, 200);
    assertEquals(await first.json(), {
      put: ["index.html", "old.css"],
      deleted: [],
      unchanged: 0,
      received_bytes: 6,
    });

    const manifest = await api(url, "GET", "/api/demo/manifest");
    assertEquals(Object.keys(manifest.body.files).sort(), [
      "index.html",
      "old.css",
    ]);

    const second = await fetch(`${url}/api/demo/sync`, {
      method: "POST",
      body: await syncBody({ "app.js": "js" }, { delete: ["old.css"] }),
    });
    assertEquals(await second.json(), {
      put: ["app.js"],
      deleted: ["old.css"],
      unchanged: 1,
      received_bytes: 2,
    });

    const tar = await fetch(`${url}/api/demo/site.tar.gz`);
    assertEquals(tar.status, 200);
    assertEquals(tar.headers.get("content-type"), "application/gzip");
    const tarBytes = new Uint8Array(await tar.arrayBuffer());
    assertEquals(tarBytes.length > 0, true);

    await api(url, "POST", "/api/demo/exec", { sql: "CREATE TABLE t (x)" });
    const db = await fetch(`${url}/api/demo/data.sqlite`);
    assertEquals(db.status, 200);
    const dbBytes = new Uint8Array(await db.arrayBuffer());
    assertEquals(
      new TextDecoder().decode(dbBytes.subarray(0, 15)),
      "SQLite format 3",
    );
  });
});

Deno.test("server: index page lists projects and escapes html", async () => {
  await withHost(async (url) => {
    await createProject(url, "alpha", "<script>alert(1)</script>");
    const res = await fetch(`${url}/`);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await res.text();
    assertEquals(html.includes(`href="/alpha/"`), true);
    assertEquals(html.includes("<script>"), false);
    assertEquals(html.includes("&lt;script&gt;"), true);
  });
});

Deno.test("server: cors on api, usage counters tick", async () => {
  await withHost(async (url) => {
    await createProject(url, "demo");
    await fetch(`${url}/api/demo/sync`, {
      method: "POST",
      body: await syncBody({ "a.txt": "a" }, { delete: [] }),
    });
    await fetch(`${url}/demo/a.txt`);
    await fetch(`${url}/demo/a.txt`);

    const list = await api(url, "GET", "/api/");
    assertEquals(
      list.body.projects[0].requests >= 3,
      true,
      "create + sync + 2 static counted",
    );
    assertEquals(list.headers.get("access-control-allow-origin"), "*");

    const preflight = await fetch(`${url}/api/demo/query`, {
      method: "OPTIONS",
    });
    assertEquals(preflight.status, 204);
    assertEquals(
      preflight.headers.get("access-control-allow-methods"),
      "GET, POST, DELETE, OPTIONS",
    );

    const badEncoding = await fetch(`${url}/demo/%zz`);
    assertEquals(badEncoding.status, 400);
  });
});
