# slopserver

Self-hosted host for slop projects: static HTML plus a per-project SQLite
database behind a small JSON API. No auth — meant to be reachable only over a
tailnet, with HTTPS from a reverse proxy.

- `slopserver-host` — the server. Project sites at `/<slug>/`, JSON API at
  `/api/`, project index at `/`.
- `slopserver` — the CLI. Creates projects, uploads site files (delta upload),
  runs SQL, downloads files/db.
- `dashboard/` — the admin dashboard, itself a slopserver project. Deploy with
  `cd dashboard && nix run ..#slopserver -- upload .`

## Quickstart

```sh
# server; everything lives under --data
nix run .#slopserver-host -- --data /var/lib/slopserver --host 0.0.0.0 --port 8787

# in a project directory
SLOPSERVER_SLUG=project-x nix run .#slopserver -- create --description "my thing"
nix run .#slopserver -- upload dist
nix run .#slopserver -- db-run "CREATE TABLE todos (id INTEGER PRIMARY KEY, text TEXT, done BOOLEAN DEFAULT 0)"
```

The project is live at `https://slop.tobtobxx.net/project-x/`. Frontend JS
calls the API same-origin:

```js
const { rows } = await (await fetch("/api/project-x/query", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    sql: "SELECT * FROM todos WHERE done = ?",
    params: [0],
  }),
})).json();
```

## CLI

| command                         | what it does                                              |
| ------------------------------- | --------------------------------------------------------- |
| `create [--description <text>]` | create the project, write ./.env                          |
| `info`                          | show config, project status and db schema (read-only)     |
| `upload <dir>`                  | mirror `<dir>` to the site; delta upload, no dotfiles     |
| `db-run "<query>"`              | run sql (multi-statement scripts fine), print json result |
| `download-db <path.sqlite>`     | pull the sqlite database                                  |
| `download <path.tar.gz>`        | pull the online files                                     |

The CLI is deliberately small: no list, no delete. A CLI session can only
ever touch the project its environment and ./.env point at, so an agent
working with it cannot damage other projects. Deleting a project is a
dashboard button.

## Config

`$SLOPSERVER_SLUG` and `$SLOPSERVER_BASE_URL` are read from the environment
and from ./.env in the current directory; already-set variables win. Default
url: `https://slop.tobtobxx.net`. `create` appends both to ./.env.

`upload` mirrors the directory: everything in it goes online, everything
missing gets deleted. Dot-prefixed files and directories (`.env`, `.git`, …)
are never uploaded.

`slopserver-host` flags: `--data <dir>` (required), `--host <host>` (default
`127.0.0.1`), `--port <port>` (default `8787`). Projects and their databases
live under `--data` — back that directory up.

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — modules, data layout, invariants
- [docs/API.md](docs/API.md) — the HTTP API
