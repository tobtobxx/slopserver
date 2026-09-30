{
  description = "slopserver: self-hosted slop host - static sites + per-project SQLite over a small JSON API";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        # node:sqlite (with FTS5) ships inside deno >= 2.2; no other dependencies.
        # Deno trusts only its bundled roots by default; also trust the system store (custom CAs).
        caStore = "system,mozilla";
        run = name: entry: pkgs.writeShellScriptBin name ''
          export DENO_TLS_CA_STORE="''${DENO_TLS_CA_STORE:-${caStore}}"
          exec ${pkgs.deno}/bin/deno run -A --no-lock ${self}/src/${entry} "$@"
        '';
        slopserver = run "slopserver" "cli.ts";
        slopserver-host = run "slopserver-host" "host.ts";
      in {
        packages = {
          inherit slopserver slopserver-host;
          default = pkgs.symlinkJoin {
            name = "slopserver-all";
            paths = [ slopserver slopserver-host ];
            meta.mainProgram = "slopserver";
          };
        };
        apps = {
          slopserver = { type = "app"; program = "${slopserver}/bin/slopserver"; };
          slopserver-host = { type = "app"; program = "${slopserver-host}/bin/slopserver-host"; };
          default = { type = "app"; program = "${slopserver}/bin/slopserver"; };
        };
        devShells.default = pkgs.mkShell {
          packages = [ pkgs.deno pkgs.sqlite ];
          DENO_TLS_CA_STORE = caStore;
        };
      });
}
