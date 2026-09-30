import { assertEquals, assertThrows } from "./_assert.ts";
import { ProjectDb } from "../src/lib/projectdb.ts";

function newDb(): ProjectDb {
  const dir = Deno.makeTempDirSync();
  const db = new ProjectDb(`${dir}/data.db`);
  db.exec("CREATE TABLE t (a INTEGER, b TEXT)");
  return db;
}

Deno.test("projectdb: query with rows as objects", () => {
  const db = newDb();
  db.exec("INSERT INTO t VALUES (1, 'x'), (2, 'y')");
  assertEquals(db.query("SELECT a, b FROM t ORDER BY a"), {
    columns: ["a", "b"],
    rows: [{ a: 1, b: "x" }, { a: 2, b: "y" }],
  });
  assertEquals(db.query("SELECT b FROM t WHERE a = ?", [2]), {
    columns: ["b"],
    rows: [{ b: "y" }],
  });
  assertEquals(db.query("SELECT a FROM t WHERE a = :a", { a: 1 }), {
    columns: ["a"],
    rows: [{ a: 1 }],
  });
  assertEquals(db.query("SELECT a FROM t WHERE 0"), {
    columns: ["a"],
    rows: [],
  }, "columns survive empty result sets");
  db.close();
});

Deno.test("projectdb: exec reports changes and rowid", () => {
  const db = newDb();
  assertEquals(db.exec("INSERT INTO t VALUES (7, 'z')"), {
    changes: 1,
    last_insert_rowid: 1,
  });
  assertEquals(db.exec("UPDATE t SET b = 'q'"), {
    changes: 1,
    last_insert_rowid: 1,
  });
  db.close();
});

Deno.test("projectdb: params codec (bool, float, blob, null)", () => {
  const db = newDb();
  db.exec("CREATE TABLE v (x)");
  db.exec("INSERT INTO v VALUES (?)", [true]);
  db.exec("INSERT INTO v VALUES (?)", [1.5]);
  db.exec("INSERT INTO v VALUES (?)", [{ blob: "AQI=" }]);
  db.exec("INSERT INTO v VALUES (?)", [null]);
  assertEquals(db.query("SELECT x, typeof(x) AS t FROM v"), {
    columns: ["x", "t"],
    rows: [
      { x: 1, t: "integer" },
      { x: 1.5, t: "real" },
      { x: { blob: "AQI=" }, t: "blob" },
      { x: null, t: "null" },
    ],
  });
  db.close();
});

Deno.test("projectdb: huge integers become strings", () => {
  const db = newDb();
  db.exec("CREATE TABLE big (v INTEGER)");
  db.exec("INSERT INTO big VALUES (9007199254740993)");
  assertEquals(db.query("SELECT v FROM big").rows, [{ v: "9007199254740993" }]);
  db.close();
});

Deno.test("projectdb: single statement enforcement", () => {
  const db = newDb();
  assertThrows(() => db.query("SELECT 1; SELECT 2"), "expected one statement");
  assertThrows(
    () => db.exec("SELECT 1; DROP TABLE t"),
    "expected one statement",
  );
  assertEquals(db.query("SELECT 1 AS one;").rows, [{ one: 1 }]);
  db.close();
});

Deno.test("projectdb: sql errors are sql_error", () => {
  const db = newDb();
  const e = assertThrows(() => db.query("SELECT * FROM missing")) as {
    code: string;
    status: number;
  };
  assertEquals(e.code, "sql_error");
  assertEquals(e.status, 400);
  db.close();
});

Deno.test("projectdb: batch mixes query and exec, commits atomically", () => {
  const db = newDb();
  const results = db.batch([
    { sql: "INSERT INTO t VALUES (?, ?)", params: [1, "a"] },
    { sql: "SELECT a FROM t" },
    { sql: "UPDATE t SET b = 'changed'" },
  ]);
  assertEquals(results, [
    { changes: 1, last_insert_rowid: 1 },
    { columns: ["a"], rows: [{ a: 1 }] },
    { changes: 1, last_insert_rowid: 1 },
  ]);
  db.close();
});

Deno.test("projectdb: batch rolls back on error", () => {
  const db = newDb();
  assertThrows(() =>
    db.batch([
      { sql: "INSERT INTO t VALUES (1, 'a')" },
      { sql: "SELECT * FROM missing" },
    ])
  );
  assertEquals(db.query("SELECT count(*) AS c FROM t").rows, [{ c: 0 }]);
  assertThrows(() => db.batch([]), "empty batch");
  db.close();
});

Deno.test("projectdb: checkpoint makes the file self-contained", () => {
  const dir = Deno.makeTempDirSync();
  const path = `${dir}/data.db`;
  const db = new ProjectDb(path);
  db.exec("CREATE TABLE t (a)");
  db.exec("INSERT INTO t VALUES (1)");
  db.checkpoint();
  const bytes = Deno.readFileSync(path);
  assertEquals(bytes.length > 0, true);
  db.close();
});
