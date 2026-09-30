// The slopserver-host HTTP server: static project sites, the project index at
// / and the JSON API at /api/. No auth anywhere - this is meant to live on a
// tailnet behind a TLS reverse proxy.
//
// Routes:
//   GET    /                          project index (built-in html)
//   GET    /api/                      project list + usage
//   POST   /api/                      create project {slug, description?}
//   DELETE /api/<slug>                delete project
//   GET    /api/<slug>/schema         tables + CREATE sql
//   POST   /api/<slug>/query          {sql, params?} -> {columns, rows}
//   POST   /api/<slug>/exec           {sql, params?} -> {changes, last_insert_rowid}
//   POST   /api/<slug>/batch          [{sql, params?}, ...] -> {results: [...]}
//   GET    /api/<slug>/manifest       {files: {path: {hash, size}}}
//   POST   /api/<slug>/sync           gzip tar delta upload
//   GET    /api/<slug>/site.tar.gz    download the site
//   GET    /api/<slug>/data.sqlite    download the database
//   GET    /<slug>/...                static files from the project site

import { SlopError, toErrorResponse } from "../lib/errors.ts";
import type { Json } from "../lib/jsonsql.ts";
import { joinUnder, safeRelPath } from "../lib/pathsafe.ts";
import { closeProjectDb, getProjectDb, type Params, type Statement } from "../lib/projectdb.ts";
import { Registry, type ProjectInfo } from "../lib/registry.ts";
import { siteTarGz, syncSite } from "../lib/site.ts";
import { assertValidSlug, isValidSlug } from "../lib/slug.ts";

export interface HostOptions {
  data: string;
  host: string;
  port: number;
}

export interface RunningHost {
  url: string;
  stop(): Promise<void>;
}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
  wasm: "application/wasm",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function methodNotAllowed(req: Request): never {
  throw new SlopError("method_not_allowed", `method ${req.method} not allowed`);
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function readJson(req: Request, maxBytes = 1 << 20): Promise<Record<string, Json>> {
  const text = await req.text();
  if (text.length > maxBytes) throw new SlopError("too_large", "request body too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text === "" ? "{}" : text);
  } catch {
    throw new SlopError("bad_request", "request body is not valid json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SlopError("bad_request", "expected a json object");
  }
  return parsed as Record<string, Json>;
}

async function readJsonArray(req: Request, maxBytes = 1 << 20): Promise<Json[]> {
  const text = await req.text();
  if (text.length > maxBytes) throw new SlopError("too_large", "request body too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SlopError("bad_request", "request body is not valid json");
  }
  if (!Array.isArray(parsed)) throw new SlopError("bad_request", "expected a json array");
  return parsed as Json[];
}

function parseParams(value: Json | undefined, what: string): Params | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value as Params;
  if (value !== null && typeof value === "object") return value as Params;
  throw new SlopError("bad_request", `${what}.params must be an array or object`);
}

function fileResponse(path: string, headers: Record<string, string>): Promise<Response> {
  return Deno.open(path, { read: true }).then((file) =>
    new Response(file.readable, { headers })
  ).catch((e) => {
    if (e instanceof Deno.errors.NotFound) throw new SlopError("not_found", `not found: ${path}`);
    throw e;
  });
}

interface Deps {
  registry: Registry;
  data: string;
  syncing: Set<string>;
}

function projectDbPath(data: string, slug: string): string {
  return `${data}/projects/${slug}/data.db`;
}

function siteDir(data: string, slug: string): string {
  return `${data}/projects/${slug}/site`;
}

// Usage numbers for one project: manifest bytes + request counters from the
// registry, db file size from disk.
function usage(data: string, registry: Registry, slug: string) {
  const { site_bytes, requests } = registry.getUsage(slug);
  let db_bytes = 0;
  try {
    db_bytes = Deno.statSync(projectDbPath(data, slug)).size;
  } catch {
    // project db not created yet
  }
  return { site_bytes, db_bytes, requests };
}

function projectJson(data: string, registry: Registry, p: ProjectInfo) {
  return {
    slug: p.slug,
    description: p.description,
    created_at: p.created_at,
    ...usage(data, registry, p.slug),
  };
}

function requireProject(registry: Registry, slug: string): ProjectInfo {
  const p = registry.getProject(slug);
  if (!p) throw new SlopError("project_not_found", `no such project: ${JSON.stringify(slug)}`);
  return p;
}

// --- request handlers ---

async function handleApiCollection(deps: Deps, req: Request): Promise<Response> {
  if (req.method === "GET") {
    return json(200, {
      projects: deps.registry.listProjects().map((p) => projectJson(deps.data, deps.registry, p)),
    });
  }
  if (req.method === "POST") {
    const body = await readJson(req);
    const slug = body.slug;
    if (typeof slug !== "string") throw new SlopError("bad_request", "missing slug");
    const description = body.description ?? "";
    if (typeof description !== "string") {
      throw new SlopError("bad_request", "description must be a string");
    }
    assertValidSlug(slug);
    // Registry first: createProject throws on an existing slug, so the
    // rollback below can never touch an existing project's files.
    const info = deps.registry.createProject(slug, description);
    try {
      await Deno.mkdir(siteDir(deps.data, slug), { recursive: true });
      getProjectDb(projectDbPath(deps.data, slug)); // empty db up front
    } catch (e) {
      closeProjectDb(projectDbPath(deps.data, slug));
      deps.registry.deleteProject(slug);
      await Deno.remove(`${deps.data}/projects/${slug}`, { recursive: true }).catch(() => {});
      throw e;
    }
    return json(201, { project: projectJson(deps.data, deps.registry, info) });
  }
  methodNotAllowed(req);
}

async function handleApiProject(deps: Deps, req: Request, slug: string, rest: string[]): Promise<Response> {
  requireProject(deps.registry, slug);
  deps.registry.incrementRequests(slug);

  if (rest.length === 0) {
    if (req.method === "DELETE") {
      closeProjectDb(projectDbPath(deps.data, slug));
      deps.registry.deleteProject(slug);
      await Deno.remove(`${deps.data}/projects/${slug}`, { recursive: true }).catch(() => {});
      return json(200, { deleted: slug });
    }
    methodNotAllowed(req);
  }

  const dbPath = projectDbPath(deps.data, slug);
  const action = rest.join("/");

  switch (action) {
    case "schema": {
      if (req.method !== "GET") methodNotAllowed(req);
      return json(200, getProjectDb(dbPath).schema());
    }
    case "query":
    case "exec":
    case "batch": {
      if (req.method !== "POST") methodNotAllowed(req);
      const db = getProjectDb(dbPath);
      if (action === "batch") {
        const body = await readJsonArray(req);
        const stmts: Statement[] = body.map((entry) => {
          if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
            throw new SlopError("bad_request", "batch entries must be {sql, params?} objects");
          }
          const stmt = entry as { sql?: Json; params?: Json };
          if (typeof stmt.sql !== "string") throw new SlopError("bad_request", "batch entry missing sql");
          return { sql: stmt.sql, params: parseParams(stmt.params, "batch entry") };
        });
        return json(200, { results: db.batch(stmts) });
      }
      const body = await readJson(req);
      if (typeof body.sql !== "string") throw new SlopError("bad_request", "missing sql");
      const params = parseParams(body.params, "body");
      return json(200, action === "query" ? db.query(body.sql, params) : db.exec(body.sql, params));
    }
    case "manifest": {
      if (req.method !== "GET") methodNotAllowed(req);
      const files: Record<string, { hash: string; size: number }> = {};
      for (const [path, meta] of deps.registry.getManifest(slug)) files[path] = meta;
      return json(200, { files });
    }
    case "sync": {
      if (req.method !== "POST") methodNotAllowed(req);
      if (!req.body) throw new SlopError("bad_request", "missing request body");
      if (deps.syncing.has(slug)) {
        throw new SlopError("project_exists", `a sync for ${JSON.stringify(slug)} is already running`);
      }
      deps.syncing.add(slug);
      try {
        const stagingDir = `${deps.data}/projects/${slug}/.staging-${
          Math.random().toString(36).slice(2)
        }`;
        const { manifest, result } = await syncSite({
          siteDir: siteDir(deps.data, slug),
          stagingDir,
          body: req.body,
          manifest: deps.registry.getManifest(slug),
        });
        deps.registry.setManifest(slug, manifest);
        return json(200, result);
      } finally {
        deps.syncing.delete(slug);
      }
    }
    case "site.tar.gz": {
      if (req.method !== "GET") methodNotAllowed(req);
      return new Response(siteTarGz(siteDir(deps.data, slug)), {
        headers: {
          "content-type": "application/gzip",
          "content-disposition": `attachment; filename="${slug}-site.tar.gz"`,
        },
      });
    }
    case "data.sqlite": {
      if (req.method !== "GET") methodNotAllowed(req);
      getProjectDb(dbPath).checkpoint();
      return await fileResponse(dbPath, {
        "content-type": "application/x-sqlite3",
        "content-disposition": `attachment; filename="${slug}.sqlite"`,
      });
    }
    default:
      throw new SlopError("not_found", `unknown api action: ${JSON.stringify(action)}`);
  }
}

// --- static files ---

function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

async function handleStatic(
  deps: Deps,
  req: Request,
  slug: string,
  pathname: string,
  rest: string[],
): Promise<Response> {
  if (req.method !== "GET") methodNotAllowed(req);
  requireProject(deps.registry, slug);
  deps.registry.incrementRequests(slug);
  const root = siteDir(deps.data, slug);

  const rel = rest.length === 0 ? "index.html" : safeRelPath(rest);
  if (rest.length === 0 && !pathname.endsWith("/")) {
    return new Response(null, { status: 301, headers: { location: `${pathname}/` } });
  }
  let filePath = joinUnder(root, rel);
  let stat = await Deno.stat(filePath).catch(() => null);
  if (stat?.isDirectory) {
    if (!pathname.endsWith("/")) {
      return new Response(null, { status: 301, headers: { location: `${pathname}/` } });
    }
    filePath = joinUnder(root, `${rel}/index.html`);
    stat = await Deno.stat(filePath).catch(() => null);
  }
  if (!stat?.isFile) throw new SlopError("not_found", `not found: ${pathname}`);

  const etag = `W/"${stat.size}-${Math.floor(stat.mtime?.getTime() ?? 0)}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  return await fileResponse(filePath, {
    "content-type": mimeFor(filePath),
    "content-length": String(stat.size),
    etag,
    "cache-control": "no-cache",
  });
}

// --- index page ---

function indexPage(deps: Deps): string {
  const rows = deps.registry.listProjects().map((p) => {
    const u = usage(deps.data, deps.registry, p.slug);
    const size = `${((u.site_bytes + u.db_bytes) / 1024).toFixed(1)} kB`;
    return `<li><a href="/${escapeHtml(p.slug)}/">${escapeHtml(p.slug)}</a>` +
      (p.description ? ` &mdash; ${escapeHtml(p.description)}` : "") +
      ` <small>(${size}, ${u.requests} requests)</small></li>`;
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>slopserver</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.4rem; }
  ul { padding-left: 1.2rem; line-height: 1.8; }
  small { color: #777; }
  footer { margin-top: 2rem; color: #777; font-size: .85rem; }
</style>
</head>
<body>
<h1>slopserver</h1>
<ul>
${rows.join("\n")}
</ul>
<footer>api: <code>/api/</code></footer>
</body>
</html>`;
}

// --- routing ---

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function withCors(res: Response, isApi: boolean): Response {
  if (!isApi) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function route(deps: Deps, req: Request): Promise<Response> {
  const url = new URL(req.url);
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    throw new SlopError("bad_request", "bad percent-encoding in url");
  }
  const segments = decoded.split("/").filter((s) => s !== "");

  if (segments.length === 0) {
    if (req.method !== "GET") methodNotAllowed(req);
    return new Response(indexPage(deps), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const isApi = segments[0] === "api";
  if (isApi) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    const rest = segments.slice(1);
    if (rest.length === 0) return await handleApiCollection(deps, req);
    return await handleApiProject(deps, req, rest[0], rest.slice(1));
  }

  const slug = segments[0];
  if (!isValidSlug(slug)) {
    throw new SlopError("not_found", `not found: ${decoded}`);
  }
  return await handleStatic(deps, req, slug, decoded, segments.slice(1));
}

export async function startHost(opts: HostOptions): Promise<RunningHost> {
  const data = opts.data.replace(/\/+$/, "");
  const registry = new Registry(`${data}/slopserver.db`);
  await Deno.mkdir(`${data}/projects`, { recursive: true });
  const deps: Deps = { registry, data, syncing: new Set() };

  let resolveReady: (url: string) => void = () => {};
  const ready = new Promise<string>((r) => (resolveReady = r));

  const isApiPath = (req: Request) => new URL(req.url).pathname.startsWith("/api");
  const server = Deno.serve(
    {
      hostname: opts.host,
      port: opts.port,
      onListen: (addr) => resolveReady(`http://${addr.hostname}:${addr.port}`),
    },
    (req) =>
      route(deps, req).then((res) => withCors(res, isApiPath(req))).catch((e) => {
        const { status, body } = toErrorResponse(e);
        return withCors(json(status, body), isApiPath(req));
      }),
  );

  return {
    url: await ready,
    async stop() {
      await server.shutdown();
      registry.close();
    },
  };
}
