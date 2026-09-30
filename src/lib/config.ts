// Config resolution for the CLI: server url and project slug.
// Precedence: flag > environment (including ./.env loaded by the CLI) > default.

import { SlopError } from "./errors.ts";

export const DEFAULT_URL = "https://slop.tobtobxx.net";

export function resolveUrl(flag?: string): string {
  const url = flag ?? Deno.env.get("SLOPSERVER_URL") ?? DEFAULT_URL;
  return url.replace(/\/+$/, "");
}

export function resolveSlug(flag?: string): string {
  const slug = flag ?? Deno.env.get("SLOPSERVER_SLUG");
  if (!slug) {
    throw new SlopError(
      "bad_request",
      "no slug: pass --slug <slug> or set SLOPSERVER_SLUG (slopserver create writes it to ./.env)",
    );
  }
  return slug;
}
