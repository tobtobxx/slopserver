// Config resolution for the CLI: server url and project slug.
// Precedence: environment (including ./.env loaded by the CLI) > default.

import { SlopError } from "./errors.ts";

export const DEFAULT_URL = "https://slop.tobtobxx.net";

export function resolveUrl(): string {
  const url = Deno.env.get("SLOPSERVER_BASE_URL") ?? DEFAULT_URL;
  return url.replace(/\/+$/, "");
}

export function resolveSlug(): string {
  const slug = Deno.env.get("SLOPSERVER_SLUG");
  if (!slug) {
    throw new SlopError(
      "bad_request",
      "no slug: set SLOPSERVER_SLUG (slopserver create writes it to ./.env)",
    );
  }
  return slug;
}
