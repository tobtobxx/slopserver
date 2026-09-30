// .env handling. The CLI reads ./.env at startup; variables already present in
// the environment win over file contents. `slopserver create` appends the
// project config to ./.env.

export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out.set(m[1], value);
  }
  return out;
}

// Set keys from the file into the environment. Existing environment variables
// take precedence.
export function loadEnvFile(path: string): void {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return;
    throw e;
  }
  for (const [key, value] of parseEnv(text)) {
    if (Deno.env.get(key) === undefined) Deno.env.set(key, value);
  }
}

function formatValue(value: string): string {
  return /[\s#"']/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

// Append keys missing from the file, leave existing entries untouched.
// Returns the keys actually written.
export function appendEnvKeys(path: string, entries: Record<string, string>): string[] {
  let text = "";
  try {
    text = Deno.readTextFileSync(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const have = parseEnv(text);
  const written: string[] = [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (have.has(key)) continue;
    lines.push(`${key}=${formatValue(value)}`);
    written.push(key);
  }
  if (lines.length > 0) {
    const prefix = text === "" || text.endsWith("\n") ? "" : "\n";
    Deno.writeTextFileSync(path, text + prefix + lines.join("\n") + "\n");
  }
  return written;
}
