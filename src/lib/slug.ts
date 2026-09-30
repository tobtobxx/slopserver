// Slug rules: lowercase url segment naming a project. "api" is the only
// reserved slug (the API lives at /api/).

import { SlopError } from "./errors.ts";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const RESERVED_SLUGS = ["api"];

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !RESERVED_SLUGS.includes(slug);
}

export function assertValidSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new SlopError(
      "invalid_slug",
      `invalid slug ${
        JSON.stringify(slug)
      }: 1-63 chars of a-z, 0-9 and '-', starting with a letter or digit`,
    );
  }
  if (RESERVED_SLUGS.includes(slug)) {
    throw new SlopError(
      "reserved_slug",
      `slug ${JSON.stringify(slug)} is reserved`,
    );
  }
}
