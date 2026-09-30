// Streaming sha256 via node:crypto (built into deno, no remote imports).

import { createHash } from "node:crypto";

export async function sha256HexFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await Deno.open(path, { read: true });
  try {
    const buf = new Uint8Array(64 * 1024);
    while (true) {
      const n = await file.read(buf);
      if (n === null) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    file.close();
  }
  return hash.digest("hex");
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}
