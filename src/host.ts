// slopserver-host: runs the slopserver.

import { startHost } from "./host/server.ts";

function usage(): string {
  return "usage: slopserver-host --data <dir> [--host <host>] [--port <port>]\n" +
    "  --data  directory for project files and databases (required)\n" +
    "  --host  bind address (default 127.0.0.1)\n" +
    "  --port  bind port (default 8787)";
}

function fail(message: string): never {
  console.error(message);
  console.error(usage());
  Deno.exit(2);
}

let data = "";
let host = "127.0.0.1";
let port = 8787;

const args = Deno.args;
for (let i = 0; i < args.length; i++) {
  const needValue = (): string => {
    const v = args[++i];
    if (v === undefined) fail(`missing value for ${args[i - 1]}`);
    return v;
  };
  switch (args[i]) {
    case "--data":
      data = needValue();
      break;
    case "--host":
      host = needValue();
      break;
    case "--port":
      port = Number(needValue());
      break;
    case "--help":
    case "-h":
      console.log(usage());
      Deno.exit(0);
      break;
    default:
      fail(`unknown argument: ${args[i]}`);
  }
}
if (data === "") fail("missing --data");
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  fail(`bad port: ${port}`);
}

const running = await startHost({ data, host, port });
console.log(`slopserver-host listening on ${running.url} (data: ${data})`);
