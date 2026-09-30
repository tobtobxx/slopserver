// Minimal assertion helpers so the whole repo stays free of remote imports.

export function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) {
      return false;
    }
    for (const [k, v] of a) {
      if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
    }
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) {
      return false;
    }
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (!deepEqual(ka, kb)) return false;
    return ka.every((k) =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      )
    );
  }
  return false;
}

export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(
      msg ??
        `assertEquals failed:\n  actual:   ${
          JSON.stringify(actual)
        }\n  expected: ${JSON.stringify(expected)}`,
    );
  }
}

export function assertThrows(fn: () => unknown, msgMatch?: string): unknown {
  try {
    fn();
  } catch (e) {
    if (msgMatch && !String((e as Error).message).includes(msgMatch)) {
      throw new Error(
        `error message ${
          JSON.stringify(String((e as Error).message))
        } does not contain ${JSON.stringify(msgMatch)}`,
      );
    }
    return e;
  }
  throw new Error("expected function to throw");
}

export async function assertRejects(
  fn: () => Promise<unknown>,
  msgMatch?: string,
): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    if (msgMatch && !String((e as Error).message).includes(msgMatch)) {
      throw new Error(
        `error message ${
          JSON.stringify(String((e as Error).message))
        } does not contain ${JSON.stringify(msgMatch)}`,
      );
    }
    return e;
  }
  throw new Error("expected function to reject");
}
