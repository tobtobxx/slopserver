// Central registry (<data>/slopserver.db): project metadata, the per-project
// file manifest (path -> sha256 + size, the basis for delta uploads) and daily
// request counters.

import { DatabaseSync } from "node:sqlite";
import { SlopError } from "./errors.ts";
import { assertValidSlug } from "./slug.ts";

export interface ProjectInfo {
  slug: string;
  description: string;
  created_at: string;
}

export interface FileMeta {
  hash: string;
  size: number;
}

export interface ProjectUsage {
  site_bytes: number;
  requests: number;
}

export class Registry {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#db.exec("PRAGMA busy_timeout=5000");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        slug TEXT PRIMARY KEY,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        slug TEXT NOT NULL,
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (slug, path)
      );
      CREATE TABLE IF NOT EXISTS requests (
        slug TEXT NOT NULL,
        day TEXT NOT NULL,
        n INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (slug, day)
      );
    `);
  }

  close(): void {
    this.#db.close();
  }

  listProjects(): ProjectInfo[] {
    return this.#db.prepare("SELECT slug, description, created_at FROM projects ORDER BY slug").all() as unknown as ProjectInfo[];
  }

  getProject(slug: string): ProjectInfo | null {
    const row = this.#db.prepare("SELECT slug, description, created_at FROM projects WHERE slug = ?").get(slug);
    return (row as ProjectInfo | undefined) ?? null;
  }

  // Throws project_exists / invalid_slug / reserved_slug.
  createProject(slug: string, description: string): ProjectInfo {
    assertValidSlug(slug);
    if (this.getProject(slug)) {
      throw new SlopError("project_exists", `project ${JSON.stringify(slug)} already exists`);
    }
    const info: ProjectInfo = {
      slug,
      description,
      created_at: new Date().toISOString(),
    };
    this.#db.prepare("INSERT INTO projects (slug, description, created_at) VALUES (?, ?, ?)").run(
      info.slug,
      info.description,
      info.created_at,
    );
    return info;
  }

  deleteProject(slug: string): void {
    this.#db.exec("BEGIN");
    try {
      this.#db.prepare("DELETE FROM projects WHERE slug = ?").run(slug);
      this.#db.prepare("DELETE FROM files WHERE slug = ?").run(slug);
      this.#db.prepare("DELETE FROM requests WHERE slug = ?").run(slug);
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  getManifest(slug: string): Map<string, FileMeta> {
    const rows = this.#db.prepare("SELECT path, hash, size FROM files WHERE slug = ?").all(slug) as unknown as {
      path: string;
      hash: string;
      size: number;
    }[];
    return new Map(rows.map((r) => [r.path, { hash: r.hash, size: r.size }]));
  }

  // Replace the manifest of a slug in one transaction (called after a sync).
  setManifest(slug: string, files: Map<string, FileMeta>): void {
    this.#db.exec("BEGIN");
    try {
      this.#db.prepare("DELETE FROM files WHERE slug = ?").run(slug);
      const ins = this.#db.prepare("INSERT INTO files (slug, path, hash, size) VALUES (?, ?, ?, ?)");
      for (const [path, meta] of files) ins.run(slug, path, meta.hash, meta.size);
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  incrementRequests(slug: string, n = 1): void {
    const day = new Date().toISOString().slice(0, 10);
    this.#db
      .prepare(
        "INSERT INTO requests (slug, day, n) VALUES (?, ?, ?) ON CONFLICT (slug, day) DO UPDATE SET n = n + excluded.n",
      )
      .run(slug, day, n);
  }

  getUsage(slug: string): ProjectUsage {
    const site = this.#db.prepare("SELECT COALESCE(SUM(size), 0) AS s FROM files WHERE slug = ?").get(slug) as {
      s: number;
    };
    const req = this.#db.prepare("SELECT COALESCE(SUM(n), 0) AS s FROM requests WHERE slug = ?").get(slug) as {
      s: number;
    };
    return { site_bytes: site.s, requests: req.s };
  }
}
