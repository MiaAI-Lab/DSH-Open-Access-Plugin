#!/usr/bin/env node
// Start the DeepSeek Harness web profile with DSH Open Access mounted, the
// way this machine does it by hand:
//
//   - bind the primary LAN interface address (the harness refuses wildcard
//     binds by design, so the plugin's aliases cover the other addresses);
//   - pre-patch dsh-client-connection once up front, so a failed patch is a
//     failed start instead of a silent token gate;
//   - the plugin then adds the no-auth cookie, the loopback and Tailscale
//     aliases, and the trusted-host entries.
//
// Usage: node scripts/serve.mjs [--port N] [--host IP] [extra dsh args...]
//   HOST / DSH_OPEN_ACCESS_HOST  bind address (default: first global IPv4)
//   PORT / DSH_OPEN_ACCESS_PORT  port (default 3081; 3080 is the stock port)

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { hostname } from "node:os";

const require = createRequire(import.meta.url);
// The dsh CLI ships with the harness; resolve it from the install this
// plugin's peer dependency came from, not from this package.
const dshBin = require.resolve("@deepseek-ai/dsh/package.json")
  .replace(/package\.json$/, "") + "lib/bin.js";
const args = process.argv.slice(2);

function flag(name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

function firstGlobalIPv4() {
  const out = execFileSync("ip", ["-4", "-o", "addr", "show", "scope", "global"], { encoding: "utf8" });
  for (const line of out.split(/\r?\n/)) {
    if (/docker|veth|br-|tailscale0/.test(line)) continue;
    const ip = line.split(/\s+/)[3]?.split("/")[0];
    if (ip) return ip;
  }
  return undefined;
}

const host = flag("--host") ?? process.env.DSH_OPEN_ACCESS_HOST ?? process.env.HOST ?? firstGlobalIPv4();
if (!host) {
  console.error("DSH Open Access: no bind address found; pass --host <ip> explicitly");
  process.exit(1);
}
const port = flag("--port") ?? process.env.DSH_OPEN_ACCESS_PORT ?? process.env.PORT ?? "3081";

// Fail loudly if the no-auth patch cannot be applied (upstream source shape
// changed); the plugin re-applies it idempotently at activation too.
const { applyNoAuthPatch } = await import("../lib/index.js");
try {
  console.log(applyNoAuthPatch());
} catch (error) {
  console.error(String(error.message ?? error));
  process.exit(1);
}

console.log(`DSH Open Access: http://${host}:${port}/ (LAN)`);
console.log(`DSH Open Access: http://${hostname()}:${port}/ (this host, via loopback alias)`);
const { tailscaleAddress } = await import("../lib/alias.js");
const ts = tailscaleAddress();
if (ts && ts !== host) console.log(`DSH Open Access: http://${ts}:${port}/ (tailscale)`);

const child = spawn(process.execPath, [
  dshBin, "web", "--host", host, "--port", port, "--no-open",
  ...args.filter((a, i) => a !== "--host" && a !== "--port" && args[i - 1] !== "--host" && args[i - 1] !== "--port"),
], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
