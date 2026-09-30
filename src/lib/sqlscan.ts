// Split SQL text into single statements. node:sqlite silently runs only the
// first statement of a multi-statement string, so the API rejects those and the
// CLI splits instead. Tracks SQLite quoting ('x', "x", `x`, [x]) and comments
// (--, /* */) so a ';' inside them is not a separator.

import { SlopError } from "./errors.ts";

function skipQuoted(sql: string, i: number, quote: string): number {
  const n = sql.length;
  let j = i + 1;
  while (j < n) {
    if (sql[j] === quote) {
      if (sql[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  throw new SlopError("bad_request", `unterminated ${quote} quote in sql`);
}

export function splitStatements(sql: string): string[] {
  const stmts: string[] = [];
  const n = sql.length;
  let stmtStart = 0;
  let tokenStart = -1;
  let i = 0;

  const markToken = () => {
    if (tokenStart < 0) tokenStart = i;
  };

  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      markToken();
      i = skipQuoted(sql, i, c);
    } else if (c === "[") {
      const end = sql.indexOf("]", i + 1);
      if (end === -1) {
        throw new SlopError("bad_request", "unterminated [identifier] in sql");
      }
      markToken();
      i = end + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i + 2);
      i = end === -1 ? n : end + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) {
        throw new SlopError("bad_request", "unterminated /* comment */ in sql");
      }
      i = end + 2;
    } else if (c === ";") {
      if (tokenStart >= 0) stmts.push(sql.slice(stmtStart, i).trim());
      stmtStart = i + 1;
      tokenStart = -1;
      i++;
    } else {
      if (!/\s/.test(c)) markToken();
      i++;
    }
  }
  if (tokenStart >= 0) stmts.push(sql.slice(stmtStart).trim());
  return stmts;
}

// Exactly one statement, for query/exec/batch entries.
export function singleStatement(sql: string): string {
  const stmts = splitStatements(sql);
  if (stmts.length === 0) {
    throw new SlopError("bad_request", "empty sql");
  }
  if (stmts.length > 1) {
    throw new SlopError(
      "bad_request",
      `expected one statement, got ${stmts.length} (node:sqlite would silently drop all but the first; use batch)`,
    );
  }
  return stmts[0];
}
