# API

Same origin as the sites. No auth. JSON in, JSON out, except static files and
the two downloads.

## Values

SQLite → JSON: `NULL`→`null`, `INTEGER`→number (string beyond 2^53),
`REAL`→number, `TEXT`→string, `BLOB`→`{"blob": "<base64>"}`.

Parameters: a JSON array binds `?` in order, a JSON object binds
`:name`/`$name`/`@name`. Booleans become 0/1; integer-valued numbers bind as
`INTEGER`, others as `REAL`.

## Errors

`{"error": {"code": "...", "message": "..."}}`:

| code                                                        | status |
| ----------------------------------------------------------- | ------ |
| `bad_request`, `invalid_slug`, `reserved_slug`, `sql_error` | 400    |
| `not_found`, `project_not_found`                            | 404    |
| `project_exists`, `conflict`                                | 409    |
| `too_large`                                                 | 413    |
| `method_not_allowed`                                        | 405    |
| `internal`                                                  | 500    |

Slugs match `[a-z0-9][a-z0-9-]{0,62}`; `api` is the only reserved one. `/api/`
answers CORS with `*`.

## Data plane — for frontend JS

| route                    | body                        | response                              |
| ------------------------ | --------------------------- | ------------------------------------- |
| `POST /api/<slug>/query` | `{"sql", "params"?}`        | `{"columns": [...], "rows": [{...}]}` |
| `POST /api/<slug>/exec`  | `{"sql", "params"?}`        | `{"changes", "last_insert_rowid"}`    |
| `POST /api/<slug>/batch` | `[{"sql", "params"?}, ...]` | `{"results": [...]}`                  |

Exactly one statement per `sql` (a trailing second statement would be silently
dropped by `node:sqlite`, so it is rejected). `batch` runs all entries in one
transaction and rolls back on the first error; each entry yields rows if the
statement returns any, change counters otherwise.

```js
await fetch("/api/project-x/query", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    sql: "INSERT INTO todos (text, done) VALUES (:text, :done)",
    params: { text: "mow lawn", done: false },
  }),
});
```

## Admin plane — CLI and dashboard

| route                         | body / notes                       | response                                                                                      |
| ----------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /api/`                   | list projects                      | `{"projects": [{"slug", "description", "created_at", "site_bytes", "db_bytes", "requests"}]}` |
| `POST /api/`                  | `{"slug", "description"?}`         | 201 `{"project": {...}}`                                                                      |
| `DELETE /api/<slug>`          | removes site, db and registry rows | `{"deleted": slug}`                                                                           |
| `GET /api/<slug>/manifest`    | current site state                 | `{"files": {"path": {"hash", "size"}}}`                                                       |
| `POST /api/<slug>/sync`       | gzip tar body, see below           | `{"put", "deleted", "unchanged", "received_bytes"}`                                           |
| `GET /api/<slug>/site.tar.gz` |                                    | the site as tar.gz                                                                            |
| `GET /api/<slug>/data.sqlite` | WAL-checkpointed first             | the SQLite database                                                                           |

The dashboard browser uses the data plane against any slug — no separate
endpoint needed.

## Sync format

`POST /api/<slug>/sync` takes a gzip'd ustar tar. Optional first entry
`_slop_sync.json` = `{"delete": ["path", ...]}`. Every other entry is a file
whose tar path becomes the site path; contents are hashed server-side. Files
neither uploaded nor deleted are kept. The result is an exact mirror of what the
uploader intended.

Applied atomically (staged, swapped in with renames), rejects paths with `..`,
overlapping put/delete entries, and concurrent syncs for the same project.
`received_bytes` counts file content only.
