// Error type shared by server and CLI. Every API error response is the JSON
// envelope {"error": {"code": ..., "message": ...}} with a status derived from
// the code.

export type ErrorCode =
  | "bad_request"
  | "invalid_slug"
  | "reserved_slug"
  | "not_found"
  | "project_not_found"
  | "project_exists"
  | "sql_error"
  | "too_large"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  invalid_slug: 400,
  reserved_slug: 400,
  not_found: 404,
  project_not_found: 404,
  project_exists: 409,
  sql_error: 400,
  too_large: 413,
  internal: 500,
};

export class SlopError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "SlopError";
    this.code = code;
    this.status = STATUS[code];
  }
}

export interface ErrorEnvelope {
  error: { code: string; message: string };
}

export function toErrorResponse(err: unknown): { status: number; body: ErrorEnvelope } {
  if (err instanceof SlopError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message } } };
  }
  console.error("internal error:", err);
  return { status: 500, body: { error: { code: "internal", message: "internal error" } } };
}
