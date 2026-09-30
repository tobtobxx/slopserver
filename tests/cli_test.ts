import { assertEquals } from "./_assert.ts";
import { runCli } from "../src/cli/commands.ts";
import { startHost } from "../src/host/server.ts";
import { gunzipBytes } from "../src/lib/gzip.ts";
import { readTar } from "../src/lib/tar.ts";

// All CLI tests share one chdir'd work directory (chdir is process-global).
async function withCli(
  fn: (url: string, work: string) => Promise<void>,
): Promise<void> {
  const data = Deno.makeTempDirSync();
  const work = Deno.makeTempDirSync();
  const host = await startHost({ data, host: "127.0.0.1", port: 0 });
  const oldCwd = Deno.cwd();
  const savedSlug = Deno.env.get("SLOPSERVER_SLUG");
  const savedUrl = Deno.env.get("SLOPSERVER_URL");
  Deno.env.delete("SLOPSERVER_SLUG");
  Deno.env.delete("SLOPSERVER_URL");
  Deno.chdir(work);
  try {
    await fn(host.url, work);
  } finally {
    Deno.chdir(oldCwd);
    await host.stop();
    if (savedSlug === undefined) Deno.env.delete("SLOPSERVER_SLUG");
    else Deno.env.set("SLOPSERVER_SLUG", savedSlug);
    if (savedUrl === undefined) Deno.env.delete("SLOPSERVER_URL");
    else Deno.env.set("SLOPSERVER_URL", savedUrl);
  }
}

function captureOutput(): { out: () => string; restore: () => void } {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  return {
    out: () => lines.join("\n"),
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

async function cli(...argv: string[]): Promise<{ code: number; out: string }> {
  const cap = captureOutput();
  try {
    const code = await runCli(argv);
    return { code, out: cap.out() };
  } finally {
    cap.restore();
  }
}

Deno.test("cli: create writes .env, repeats fail", async () => {
  await withCli(async (url, work) => {
    const created = await cli(
      "create",
      "--url",
      url,
      "--slug",
      "app",
      "--description",
      "my app",
    );
    assertEquals(created.code, 0);
    assertEquals(created.out.includes(`created ${url}/app/`), true);
    const env = Deno.readTextFileSync(`${work}/.env`);
    assertEquals(env.includes("SLOPSERVER_SLUG=app"), true);
    assertEquals(env.includes(`SLOPSERVER_URL=${url}`), true);

    const again = await cli("create", "--url", url, "--slug", "app");
    assertEquals(again.code, 1);
    assertEquals(again.out.includes("already exists"), true);

    const list = await (await fetch(`${url}/api/`)).json() as {
      projects: { slug: string; description: string }[];
    };
    assertEquals(list.projects.map((p) => [p.slug, p.description]), [[
      "app",
      "my app",
    ]]);
  });
});

Deno.test("cli: create without a slug explains the config", async () => {
  await withCli(async (url) => {
    const res = await cli("create", "--url", url);
    assertEquals(res.code, 1);
    assertEquals(res.out.includes("no slug"), true);
  });
});

Deno.test("cli: upload mirrors a directory and only sends deltas", async () => {
  await withCli(async (url, work) => {
    await cli("create", "--url", url, "--slug", "app");
    await Deno.mkdir(`${work}/site/sub`, { recursive: true });
    await Deno.writeTextFile(`${work}/site/index.html`, "hello");
    await Deno.writeTextFile(`${work}/site/app.js`, "v1");
    await Deno.writeTextFile(`${work}/site/sub/x.txt`, "nested");

    const first = await cli("upload", "site");
    assertEquals(first.code, 0, first.out);
    assertEquals(first.out.includes("uploaded 3 files"), true);
    assertEquals(first.out.includes("deleted 0"), true);

    const again = await cli("upload", "site");
    assertEquals(again.out.includes("up to date (3 files)"), true);

    await Deno.writeTextFile(`${work}/site/app.js`, "v2 changed");
    await Deno.remove(`${work}/site/sub/x.txt`);
    await Deno.writeTextFile(`${work}/site/new.css`, "css");
    const delta = await cli("upload", "site");
    assertEquals(delta.out.includes("uploaded 2 files"), true);
    assertEquals(delta.out.includes("deleted 1"), true);
    assertEquals(delta.out.includes("unchanged 1"), true);

    const manifest = await (await fetch(`${url}/api/app/manifest`)).json() as {
      files: Record<string, { size: number }>;
    };
    assertEquals(Object.keys(manifest.files).sort(), [
      "app.js",
      "index.html",
      "new.css",
    ]);
    assertEquals(manifest.files["app.js"].size, "v2 changed".length);

    const served = await (await fetch(`${url}/app/app.js`)).text();
    assertEquals(served, "v2 changed", "site replaced with local state");
  });
});

Deno.test("cli: upload reads slug and url from .env", async () => {
  await withCli(async (url, work) => {
    await cli("create", "--url", url, "--slug", "envslug");
    await Deno.writeTextFile(`${work}/only.txt`, "x");
    const res = await cli("upload", ".");
    assertEquals(res.code, 0, res.out);
    const served = await (await fetch(`${url}/envslug/only.txt`)).text();
    assertEquals(served, "x");
  });
});

Deno.test("cli: upload ignores dotfiles and dot-directories", async () => {
  await withCli(async (url, work) => {
    await cli("create", "--url", url, "--slug", "app");
    await Deno.mkdir(`${work}/site/sub`, { recursive: true });
    await Deno.mkdir(`${work}/site/.git`, { recursive: true });
    await Deno.writeTextFile(`${work}/site/index.html`, "hello");
    await Deno.writeTextFile(`${work}/site/.env`, "SLOPSERVER_SLUG=app");
    await Deno.writeTextFile(`${work}/site/sub/.hidden`, "junk");
    await Deno.writeTextFile(`${work}/site/sub/ok.txt`, "kept");
    await Deno.writeTextFile(`${work}/site/.git/config`, "junk");

    const res = await cli("upload", "site");
    assertEquals(res.code, 0, res.out);
    assertEquals(res.out.includes("uploaded 2 files"), true, res.out);

    const manifest = await (await fetch(`${url}/api/app/manifest`)).json() as {
      files: Record<string, unknown>;
    };
    assertEquals(Object.keys(manifest.files).sort(), [
      "index.html",
      "sub/ok.txt",
    ]);
  });
});

Deno.test("cli: info reports config and project status", async () => {
  await withCli(async (url, work) => {
    await cli("create", "--url", url, "--slug", "app");
    const ok = await cli("info", "--url", url);
    assertEquals(ok.code, 0, ok.out);
    assertEquals(ok.out.includes(`url       ${url} (flag)`), true, ok.out);
    assertEquals(ok.out.includes("server    ok, 1 projects"), true, ok.out);
    assertEquals(ok.out.includes("slug      app (env)"), true, ok.out);
    assertEquals(ok.out.includes(`project   ${url}/app/`), true, ok.out);
    assertEquals(ok.out.includes("site      0 files, 0 bytes"), true, ok.out);
    assertEquals(ok.out.includes("requests"), true, ok.out);

    const missing = await cli("info", "--url", url, "--slug", "nope");
    assertEquals(missing.code, 1);
    assertEquals(missing.out.includes("no project 'nope'"), true, missing.out);
  });
});

Deno.test("cli: db-run executes scripts and prints json", async () => {
  await withCli(async (url) => {
    await cli("create", "--url", url, "--slug", "app");
    const script = await cli(
      "db-run",
      "CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);",
    );
    assertEquals(script.code, 0, script.out);

    const single = await cli("db-run", "SELECT x FROM t ORDER BY x");
    assertEquals(single.code, 0);
    assertEquals(JSON.parse(single.out), {
      columns: ["x"],
      rows: [{ x: 1 }, { x: 2 }],
    });

    const multi = await cli("db-run", "SELECT 1 AS a; SELECT 2 AS b");
    assertEquals(JSON.parse(multi.out).results, [
      { columns: ["a"], rows: [{ a: 1 }] },
      { columns: ["b"], rows: [{ b: 2 }] },
    ]);

    const failing = await cli("db-run", "SELECT * FROM missing");
    assertEquals(failing.code, 1);
    assertEquals(failing.out.includes("no such table"), true);
  });
});

Deno.test("cli: download and download-db pull real files", async () => {
  await withCli(async (url, work) => {
    await cli("create", "--url", url, "--slug", "app");
    await Deno.writeTextFile(`${work}/f.txt`, "content");
    await cli("upload", ".");
    await cli("db-run", "CREATE TABLE t (x)");

    const db = await cli("download-db", "backup.sqlite");
    assertEquals(db.code, 0);
    const dbBytes = Deno.readFileSync(`${work}/backup.sqlite`);
    assertEquals(
      new TextDecoder().decode(dbBytes.subarray(0, 15)),
      "SQLite format 3",
    );

    const dl = await cli("download", "site.tar.gz");
    assertEquals(dl.code, 0);
    const tar = await gunzipBytes(Deno.readFileSync(`${work}/site.tar.gz`));
    const files: Record<string, string> = {};
    for await (const e of readTar(new Blob([tar as BlobPart]).stream())) {
      files[e.path] = new TextDecoder().decode(e.bytes);
    }
    assertEquals(files["f.txt"], "content");
    assertEquals(files[".env"], undefined, "dotfiles never go online");
  });
});

Deno.test("cli: help, unknown command, unknown project", async () => {
  await withCli(async (url) => {
    const help = await cli("--help");
    assertEquals(help.code, 0);
    assertEquals(help.out.includes("slopserver upload <dir>"), true);

    const empty = await cli();
    assertEquals(empty.code, 2, "no command is a usage error");

    const unknown = await cli("frobnicate");
    assertEquals(unknown.code, 1);
    assertEquals(unknown.out.includes("unknown command"), true);

    const noProject = await cli(
      "db-run",
      "SELECT 1",
      "--url",
      url,
      "--slug",
      "ghost",
    );
    assertEquals(noProject.code, 1);
    assertEquals(noProject.out.includes("no such project"), true);

    const unreachable = await cli(
      "create",
      "--url",
      "http://127.0.0.1:1",
      "--slug",
      "x",
    );
    assertEquals(unreachable.code, 1);
    assertEquals(unreachable.out.includes("cannot reach"), true);
  });
});
