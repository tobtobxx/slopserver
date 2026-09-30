// Path safety for anything that lands on disk or is served from disk: tar
// entry names and URL paths both become site-relative paths here. Rejects
// traversal, NUL and backslashes.

import { SlopError } from "./errors.ts";

// Drop "" and "." segments, reject everything that could escape the root.
// Returns the normalized relative path (no leading slash).
export function safeRelPath(rawSegments: string[]): string {
  const out: string[] = [];
  for (const seg of rawSegments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      throw new SlopError("bad_request", "path must not contain '..'");
    }
    if (seg.includes("\0") || seg.includes("\\")) {
      throw new SlopError("bad_request", "path contains forbidden characters");
    }
    out.push(seg);
  }
  if (out.length === 0) {
    throw new SlopError("bad_request", "empty path");
  }
  return out.join("/");
}

// Parse a slash-separated path (tar entry name, manifest path, delete list
// entry) into a safe relative path.
export function relPathFromString(p: string): string {
  return safeRelPath(p.split("/"));
}

// Join under a root. Normalizes the path first and double-checks the result
// stays inside the root.
export function joinUnder(root: string, rel: string): string {
  const safe = relPathFromString(rel);
  const full = `${root}/${safe}`;
  const rootPrefix = root.endsWith("/") ? root : root + "/";
  if (!full.startsWith(rootPrefix)) {
    throw new SlopError(
      "bad_request",
      `path ${JSON.stringify(rel)} escapes the root`,
    );
  }
  return full;
}
