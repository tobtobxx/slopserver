# slopserver

Self-hosted host for slop projects: static HTML plus a per-project SQLite database behind a small JSON API. No auth — meant to be reachable only over a tailnet (HTTPS via reverse proxy).

- `slopserver-host` — the server. Serves project sites, the JSON API and a project index at `/`.
- `slopserver` — the CLI. Creates projects, uploads site files (delta upload), runs SQL, downloads files/DB.

Docs: [ARCHITECTURE.md](ARCHITECTURE.md), [docs/API.md](docs/API.md).
