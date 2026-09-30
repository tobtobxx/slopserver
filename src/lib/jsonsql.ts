// JSON <-> SQLite value codec.
//
// Encoding (rows and exec results):
//   NULL -> null, INTEGER -> number (string if beyond 2^53), REAL -> number,
//   TEXT -> string, BLOB -> {"blob": "<base64>"}.
// Decoding (parameters): null -> NULL, bool -> INTEGER 0/1,
//   integer number -> INTEGER, other number -> REAL, string -> TEXT,
//   {"blob": "<base64>"} -> BLOB. Other objects/arrays are rejected.

import { SlopError } from "./errors.ts";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type SqlValue = null | number | bigint | string | Uint8Array;

export function toBase64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  let s: string;
  try {
    s = atob(b64);
  } catch {
    throw new SlopError("bad_request", "invalid base64 in blob value");
  }
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function isBlob(v: object): v is { blob: string } {
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0] === "blob" && typeof (v as { blob?: unknown }).blob === "string";
}

export function bindValue(v: Json): SqlValue {
  if (v === null) return null;
  switch (typeof v) {
    case "boolean":
      return v ? 1n : 0n;
    case "number":
      return Number.isSafeInteger(v) ? BigInt(v) : v;
    case "string":
      return v;
    case "object": {
      if (!Array.isArray(v) && isBlob(v)) return fromBase64(v.blob);
      break;
    }
  }
  throw new SlopError(
    "bad_request",
    `cannot bind ${JSON.stringify(v)}; use null, boolean, number, string or {"blob": "<base64>"}`,
  );
}

export function encodeValue(v: SqlValue): Json {
  if (v === null) return null;
  if (typeof v === "bigint") {
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(v)
      : v.toString();
  }
  if (v instanceof Uint8Array) return { blob: toBase64(v) };
  return v;
}
