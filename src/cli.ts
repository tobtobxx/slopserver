// slopserver: command line interface for slopserver-host.

import { runCli } from "./cli/commands.ts";

Deno.exit(await runCli(Deno.args));
