// Site directory operations: the delta-sync that backs `slopserver upload`,
// manifest handling and the tar.gz export behind `slopserver download`.
//
// Sync applies changes to a staging directory and then swaps it into place
// with two renames, so concurrent readers see either the old or the new site.

import { gunzipStream, gzipStream } from "./gzip.ts";
import { sha256HexFile } from "./hash.ts";
import { joinUnder, relPathFromString } from "./pathsafe.ts";
import type { FileMeta } from "./registry.ts";
import { readTar, tarStream, type TarEntry } from "./tar.ts";
import { SlopError } from "./errors.ts";

export const SYNC_META_ENTRY = "_slop_sync.json";

export interface SyncMeta {
  delete?: string[];
}

export interface SyncResult {
  put: string[];
  deleted: string[];
  unchanged: number;
  received_bytes: number;
}

async function* walkFiles(dir: string, prefix = ""): AsyncGenerator<string> {
  const entries = [];
  for await (const e of Deno.readDir(dir)) entries.push(e);
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory) yield* walkFiles(`${dir}/${e.name}`, rel);
    else if (e.isFile) yield rel;
  }
}

async function ensureParent(path: string): Promise<void> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
}

// All files currently in the site directory (regular files only).
export function siteEntries(siteDir: string): AsyncIterable<TarEntry> {
  return (async function* () {
    for await (const rel of walkFiles(siteDir)) {
      yield { path: rel, bytes: await Deno.readFile(joinUnder(siteDir, rel)) };
    }
  })();
}

export function siteTarGz(siteDir: string): ReadableStream<Uint8Array> {
  return gzipStream(tarStream(siteEntries(siteDir)));
}

// Apply a sync upload: stage the incoming files, carry over unchanged ones,
// swap into place, return the new manifest (caller persists it to the
// registry) plus stats.
export async function syncSite(opts: {
  siteDir: string;
  stagingDir: string;
  body: ReadableStream<Uint8Array>;
  manifest: Map<string, FileMeta>;
}): Promise<{ manifest: Map<string, FileMeta>; result: SyncResult }> {
  const { siteDir, stagingDir, body, manifest } = opts;
  const inDir = `${stagingDir}/in`;
  const outDir = `${stagingDir}/out`;
  const oldDir = `${stagingDir}/old`;
  await Deno.mkdir(inDir, { recursive: true });
  await Deno.mkdir(outDir, { recursive: true });

  try {
    // Stage incoming files and record their hashes.
    const meta: SyncMeta = {};
    const put = new Map<string, FileMeta>();
    let received = 0;
    for await (const entry of readTar(gunzipStream(body))) {
      received += entry.bytes.length;
      if (entry.path === SYNC_META_ENTRY) {
        Object.assign(meta, JSON.parse(new TextDecoder().decode(entry.bytes)));
        continue;
      }
      const rel = relPathFromString(entry.path);
      const dest = joinUnder(inDir, rel);
      await ensureParent(dest);
      await Deno.writeFile(dest, entry.bytes);
      put.set(rel, { hash: await sha256HexFile(dest), size: entry.bytes.length });
    }

    const deleted = (meta.delete ?? []).map((p) => relPathFromString(p));
    const deletedSet = new Set(deleted);
    for (const p of deletedSet) {
      if (put.has(p)) {
        throw new SlopError("bad_request", `path ${JSON.stringify(p)} is both uploaded and deleted`);
      }
    }

    // Carry unchanged files over; everything else comes from the upload or
    // disappears.
    const next = new Map<string, FileMeta>();
    for (const [rel, fileMeta] of manifest) {
      if (put.has(rel) || deletedSet.has(rel)) continue;
      const src = joinUnder(siteDir, rel);
      try {
        await ensureParent(joinUnder(outDir, rel));
        await Deno.rename(src, joinUnder(outDir, rel));
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
        continue; // drifted from the manifest; file is gone, drop it
      }
      next.set(rel, fileMeta);
    }
    for (const [rel, fileMeta] of put) {
      await ensureParent(joinUnder(outDir, rel));
      await Deno.rename(joinUnder(inDir, rel), joinUnder(outDir, rel));
      next.set(rel, fileMeta);
    }

    // Swap into place.
    await Deno.rename(siteDir, oldDir);
    await Deno.rename(outDir, siteDir);
    await Deno.remove(oldDir, { recursive: true });

    return {
      manifest: next,
      result: {
        put: [...put.keys()].sort(),
        deleted: deleted.sort(),
        unchanged: next.size - put.size,
        received_bytes: received,
      },
    };
  } finally {
    await Deno.remove(stagingDir, { recursive: true }).catch(() => {});
  }
}
