// slopserver: the CLI. Talks to a slopserver-host over HTTP.
//
// Commands:
//   create      create the project and write ./.env
//   info        show config, status and db schema (read-only)
//   upload      mirror a local directory to the project site (delta upload)
//   db-run      run sql against the project db
//   download-db pull the sqlite database
//   download    pull the online files as tar.gz
//
// Slug and server url resolution: environment (./.env is loaded at startup,
// existing variables win) > default url. `create` appends SLOPSERVER_SLUG and
// SLOPSERVER_BASE_URL to ./.env.

import { DEFAULT_URL, resolveSlug, resolveUrl } from "../lib/config.ts";
import { appendEnvKeys, loadEnvFile } from "../lib/envfile.ts";
import { SlopError } from "../lib/errors.ts";
import { sha256HexFile } from "../lib/hash.ts";
import { joinUnder } from "../lib/pathsafe.ts";
import { gzipStream } from "../lib/gzip.ts";
import { splitStatements } from "../lib/sqlscan.ts";
import { type TarEntry, tarStream } from "../lib/tar.ts";
import { SYNC_META_ENTRY, type SyncMeta } from "../lib/site.ts";

interface Options {
  description?: string;
  positionals: string[];
}

export function helpText(): string {
  return `slopserver - cli for slopserver-host

usage:
  slopserver create [--description <text>]     create the project, write .env
  slopserver info                              show config, status and db schema
  slopserver upload <dir>                      mirror <dir> to the project site
  slopserver db-run "<query>"                  run sql, print json result
  slopserver download-db <path.sqlite>         download the sqlite database
  slopserver download <path.tar.gz>            download the online files

environment (read from .env if not present):
  $SLOPSERVER_BASE_URL     backend server url (default: ${DEFAULT_URL})
  $SLOPSERVER_SLUG         project slug

The create subcommand writes to .env , so future calls automatically use
the correct slug, even when no env vars are set.`;
}

function parseArgs(argv: string[]): { command: string; opts: Options } {
  const opts: Options = { positionals: [] };
  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const needValue = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        throw new SlopError("bad_request", `missing value for ${arg}`);
      }
      return v;
    };
    switch (arg) {
      case "--description":
        opts.description = needValue();
        break;
      case "--help":
      case "-h":
        command = "help";
        break;
      default:
        if (arg.startsWith("--")) {
          throw new SlopError("bad_request", `unknown option: ${arg}`);
        }
        if (command === "") command = arg;
        else opts.positionals.push(arg);
    }
  }
  return { command, opts };
}

function print(line: string): void {
  console.log(line);
}

async function api(
  url: string,
  method: string,
  path: string,
  body?: BodyInit | null,
  contentType?: string,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url + path, {
      method,
      headers: contentType ? { "content-type": contentType } : undefined,
      body,
      // needed when body is a ReadableStream (the sync upload)
      duplex: "half",
    } as RequestInit);
  } catch (e) {
    throw new SlopError(
      "bad_request",
      `cannot reach ${url}: ${(e as Error).message}`,
    );
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => null) as {
      error?: { message?: string };
    } | null;
    throw new SlopError(
      "bad_request",
      payload?.error?.message ?? `server returned ${res.status}`,
    );
  }
  return res;
}

async function apiJson(
  url: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await api(
    url,
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
    body === undefined ? undefined : "application/json",
  );
  return await res.json();
}

// --- local site walking, for upload ---

interface LocalFile {
  path: string;
  size: number;
  hash: string;
}

// Walk a local directory, yielding site-relative paths with hashes. root stays
// fixed, prefix accumulates, so paths never double up. Dot-prefixed entries
// stay local: .env, .git and friends never go online.
async function walkLocal(root: string, prefix = ""): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  const current = prefix ? `${root}/${prefix}` : root;
  const entries = [];
  for await (const e of Deno.readDir(current)) entries.push(e);
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory) {
      out.push(...await walkLocal(root, path));
    } else if (e.isFile) {
      const full = joinUnder(root, path);
      const stat = await Deno.stat(full);
      out.push({ path, size: stat.size, hash: await sha256HexFile(full) });
    }
  }
  return out;
}

// --- commands ---

async function cmdCreate(url: string, opts: Options): Promise<void> {
  const slug = resolveSlug();
  const created = await apiJson(url, "POST", "/api/", {
    slug,
    description: opts.description ?? "",
  }) as { project: { slug: string } };
  const written = appendEnvKeys(".env", {
    SLOPSERVER_SLUG: created.project.slug,
    SLOPSERVER_BASE_URL: url,
  });
  print(`created ${url}/${created.project.slug}/`);
  if (written.length > 0) print(`wrote ${written.join(", ")} to ./.env`);
}

// Smoke test for a deployment: where do url and slug come from, is the server
// reachable, does the project exist. Read-only, so it is safe to run anywhere.
async function cmdInfo(url: string): Promise<void> {
  const urlSource = Deno.env.get("SLOPSERVER_BASE_URL") ? "env" : "default";
  const list = await apiJson(url, "GET", "/api/") as {
    projects: {
      slug: string;
      created_at: string;
      site_bytes: number;
      db_bytes: number;
      requests: number;
    }[];
  };
  print(`url       ${url} (${urlSource})`);
  print(`server    ok, ${list.projects.length} projects`);

  const slug = Deno.env.get("SLOPSERVER_SLUG");
  if (!slug) return;
  print(`slug      ${slug}`);
  const project = list.projects.find((p) => p.slug === slug);
  if (!project) {
    throw new SlopError("project_not_found", `no project '${slug}' on ${url}`);
  }
  const { files } = await (await api(url, "GET", `/api/${slug}/manifest`))
    .json() as { files: Record<string, { size: number }> };
  const sizes = Object.values(files);
  print(`project   ${url}/${slug}/`);
  print(`created   ${project.created_at}`);
  print(
    `site      ${sizes.length} files, ${
      sizes.reduce((a, f) => a + f.size, 0)
    } bytes`,
  );
  print(`db        ${project.db_bytes} bytes`);
  // Columns via pragma_table_info, no CREATE-sql parsing. Full CREATE
  // statements are a `db-run` away.
  const { rows } = await apiJson(url, "POST", `/api/${slug}/query`, {
    sql: "SELECT m.name AS tbl, p.name AS col FROM sqlite_master AS m " +
      "JOIN pragma_table_info(m.name) AS p " +
      "WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' " +
      "ORDER BY m.name, p.cid",
  }) as { rows: { tbl: string; col: string | null }[] };
  const tables = new Map<string, string[]>();
  for (const row of rows) {
    const cols = tables.get(row.tbl) ?? [];
    if (row.col) cols.push(row.col);
    tables.set(row.tbl, cols);
  }
  print(`schema    ${tables.size} tables:`);
  for (const [name, cols] of tables) {
    print(`               ${name} (${cols.join(", ")})`);
  }
  print(`requests  ${project.requests}`);
}

async function cmdUpload(url: string, opts: Options): Promise<void> {
  const [dir] = opts.positionals;
  if (!dir) {
    throw new SlopError(
      "bad_request",
      "upload needs a directory: slopserver upload <dir>",
    );
  }
  const slug = resolveSlug();
  const stat = await Deno.stat(dir).catch(() => null);
  if (!stat?.isDirectory) {
    throw new SlopError("bad_request", `not a directory: ${dir}`);
  }

  const manifestRes = await api(url, "GET", `/api/${slug}/manifest`);
  const { files } = await manifestRes.json() as {
    files: Record<string, { hash: string; size: number }>;
  };

  const local = await walkLocal(dir);
  const put: LocalFile[] = [];
  const deleted: string[] = [];
  let unchanged = 0;
  const localPaths = new Set<string>();
  for (const f of local) {
    localPaths.add(f.path);
    const remote = files[f.path];
    if (remote && remote.hash === f.hash && remote.size === f.size) unchanged++;
    else put.push(f);
  }
  for (const path of Object.keys(files)) {
    if (!localPaths.has(path)) deleted.push(path);
  }

  if (put.length === 0 && deleted.length === 0) {
    print(`up to date (${unchanged} files)`);
    return;
  }

  const meta: SyncMeta = { delete: deleted };
  async function* entries(): AsyncGenerator<TarEntry> {
    yield {
      path: SYNC_META_ENTRY,
      bytes: new TextEncoder().encode(JSON.stringify(meta)),
    };
    for (const f of put) {
      yield {
        path: f.path,
        bytes: await Deno.readFile(joinUnder(dir, f.path)),
      };
    }
  }
  const body = gzipStream(tarStream(entries()));
  const res = await api(
    url,
    "POST",
    `/api/${slug}/sync`,
    body as unknown as BodyInit,
  );
  const result = await res.json() as { received_bytes: number };
  print(
    `uploaded ${put.length} files (${
      (result.received_bytes / 1024).toFixed(1)
    } kB), ` +
      `deleted ${deleted.length}, unchanged ${unchanged}`,
  );
}

async function cmdDbRun(url: string, opts: Options): Promise<void> {
  const [query] = opts.positionals;
  if (!query) {
    throw new SlopError(
      "bad_request",
      'db-run needs a query: slopserver db-run "SELECT ..."',
    );
  }
  const slug = resolveSlug();
  const stmts = splitStatements(query).map((sql) => ({ sql }));
  const body = await apiJson(url, "POST", `/api/${slug}/batch`, stmts) as {
    results: unknown[];
  };
  // One statement: print its result bare. Several: print the whole batch.
  print(JSON.stringify(stmts.length === 1 ? body.results[0] : body, null, 2));
}

async function cmdDownloadDb(url: string, opts: Options): Promise<void> {
  const [target] = opts.positionals;
  if (!target) {
    throw new SlopError("bad_request", "download-db needs a target path");
  }
  const slug = resolveSlug();
  const res = await api(url, "GET", `/api/${slug}/data.sqlite`);
  await Deno.writeFile(target, res.body!);
  print(`wrote ${target} (${(await Deno.stat(target)).size} bytes)`);
}

async function cmdDownload(url: string, opts: Options): Promise<void> {
  const [target] = opts.positionals;
  if (!target) {
    throw new SlopError("bad_request", "download needs a target path");
  }
  const slug = resolveSlug();
  const res = await api(url, "GET", `/api/${slug}/site.tar.gz`);
  await Deno.writeFile(target, res.body!);
  print(`wrote ${target} (${(await Deno.stat(target)).size} bytes)`);
}

export async function runCli(argv: string[]): Promise<number> {
  try {
    loadEnvFile(".env");
    const { command, opts } = parseArgs(argv);
    if (command === "" || command === "help") {
      print(helpText());
      return command === "" ? 2 : 0;
    }
    const url = resolveUrl();
    switch (command) {
      case "create":
        await cmdCreate(url, opts);
        break;
      case "info":
        await cmdInfo(url);
        break;
      case "upload":
        await cmdUpload(url, opts);
        break;
      case "db-run":
        await cmdDbRun(url, opts);
        break;
      case "download-db":
        await cmdDownloadDb(url, opts);
        break;
      case "download":
        await cmdDownload(url, opts);
        break;
      default:
        throw new SlopError("bad_request", `unknown command: ${command}`);
    }
    return 0;
  } catch (e) {
    console.error(
      e instanceof SlopError ? e.message : `unexpected error: ${e}`,
    );
    return 1;
  }
}
