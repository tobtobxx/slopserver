# Architecture

Two binaries from one codebase, both thin wrappers around `src/lib/`:
`slopserver-host` (`src/host.ts`) serves, `slopserver` (`src/cli.ts`) is an HTTP
client. Zero remote imports — everything runs on Deno builtins plus
`node:sqlite`.

## Files

| file                                      | what                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `src/host/server.ts`                      | routing, static serving, index page, API handlers                                |
| `src/cli/commands.ts`                     | the CLI commands, local dir walking, arg parsing                                 |
| `src/lib/registry.ts`                     | `slopserver.db`: projects, file manifest (sha256 + size), daily request counters |
| `src/lib/projectdb.ts`                    | per-project SQLite: query/exec/batch, WAL, codec hookup                          |
| `src/lib/site.ts`                         | delta sync (stage + swap), site export                                           |
| `src/lib/tar.ts`                          | ustar writer/reader (deterministic, mtime 0)                                     |
| `src/lib/jsonsql.ts`                      | JSON ↔ SQLite value codec (blob convention)                                      |
| `src/lib/sqlscan.ts`                      | statement splitter                                                               |
| `src/lib/pathsafe.ts`                     | traversal guard for tar entries and URLs                                         |
| `src/lib/config.ts`, `src/lib/envfile.ts` | slug/url resolution, .env load/append                                            |
| `src/lib/errors.ts`                       | `SlopError` codes → status + JSON envelope                                       |
| `src/lib/gzip.ts`, `hash.ts`, `binary.ts` | gzip streams, streaming sha256, buffered stream reads                            |
| `dashboard/index.html`                    | admin dashboard, itself a slopserver project (`cd dashboard && nix run ..#slopserver -- upload .`) |

## Data layout (`--data`)

```
<data>/
  slopserver.db                  registry
  projects/<slug>/site/          static files, served at /<slug>/
  projects/<slug>/data.db        project database (+ -wal/-shm)
  projects/<slug>/.staging-*/    transient sync state
```

## Request flow

Static: route → slug check → project lookup → pathsafe → file (etag / 304). API:
route → project lookup → one handler per action → `projectdb` or `registry`.
Everything throws `SlopError`; one catch turns it into the JSON error envelope.

## Invariants

- **No auth anywhere.** Tailnet only.
- **Path safety.** Everything that hits disk goes through `pathsafe` (tar
  entries, URLs). `deno.serve` additionally collapses dot segments before
  routing.
- **One statement per query/exec.** `node:sqlite` would silently run only the
  first of several — the splitter rejects them. `batch` runs many in one
  transaction, rolls back on error.
- **Sync is atomic per request.** Stage → carry over unchanged → two renames →
  manifest update. One sync per project at a time.
- **Manifest drives deltas.** Registry hashes let `upload` send only changed
  files. Drift (files edited on disk) self-heals on the next sync.

## Seams

- `ProjectDb` (`src/lib/projectdb.ts`) — the whole database interface.
  `node:sqlite` is synchronous, so queries block the event loop briefly; if that
  ever hurts, move it behind a worker without changing the API.
- `syncSite` (`src/lib/site.ts`) — pure site-directory operation, knows nothing
  about HTTP or the registry.
- Tests: `deno test -A tests/`, own assertion helpers in `tests/_assert.ts`.
