#!/usr/bin/env node
// Byte-level TCP forwarder, exported as a reusable module and runnable as a
// child process. It lets addresses other than the one dsh binds answer on the
// same port: loopback (so http://<hostname>:<port>/ works on the host itself
// when DNS maps the machine name to 127.0.0.1) and the Tailscale address.
//
// The bytes pass through untouched, so HTTP and WebSocket upgrades both work
// and dsh still sees the browser's original Host header — which is exactly
// what the /api trust fence reads, so every Host this alias serves must also
// be a trusted authority (see lib/index.js).
//
// CLI usage (also spawned by lib/index.js):
//   node alias.mjs <listen host:port> <target host:port>

import net from "node:net";
import childProcess from "node:child_process";

/** Parse `host:port` (IPv6 may arrive bracketed on the CLI). */
export function parseAddress(value) {
  const index = value.lastIndexOf(":");
  if (index <= 0) throw new Error(`expected host:port, got ${JSON.stringify(value)}`);
  const host = value.slice(0, index).replace(/^\[|\]$/g, "");
  const port = Number(value.slice(index + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port in ${JSON.stringify(value)}`);
  }
  return { host, port };
}

/**
 * Forward one address to another until disposed. Never binds a wildcard
 * address: the point of the harness bind policy is one concrete interface,
 * and this shim keeps that property.
 * @param listen {{host: string, port: number}} address to accept on
 * @param target {{host: string, port: number}} address to forward to
 * @param log {(message: string) => void} line logger
 * @returns {{dispose: () => Promise<void>, address: {host: string, port: number}}}
 */
export function forwardAddress(listen, target, log = console.log) {
  if (net.isIP(listen.host) === 0) throw new Error(`alias host must be an IP literal, got ${JSON.stringify(listen.host)}`);
  const server = net.createServer({ allowHalfOpen: false }, (client) => {
    const upstream = net.connect({ host: target.host, port: target.port });
    const shutdown = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", shutdown);
    upstream.on("error", shutdown);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  const ready = new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        // Another instance of this alias is already listening (a restart
        // while the old forwarder still runs). Leave it alone.
        log(`DSH Open Access: ${listen.host}:${listen.port} already forwarding, leaving it alone`);
        resolve();
      } else {
        reject(error);
      }
    });
    server.listen({ host: listen.host, port: listen.port }, () => {
      log(`DSH Open Access: forwarding ${listen.host}:${listen.port} -> ${target.host}:${target.port}`);
      resolve();
    });
  });
  return {
    address: listen,
    async dispose() {
      await ready.catch(() => {});
      await new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
    },
  };
}

/** Detect the host's Tailscale IPv4 address, or undefined without Tailscale. */
export function tailscaleAddress() {
  try {
    const { execFileSync } = childProcess;
    const out = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    const ip = out.split(/\r?\n/).map((line) => line.trim()).find((line) => net.isIP(line) === 4);
    return ip || undefined;
  } catch {
    return undefined;
  }
}

/** Addresses this machine owns that are worth aliasing, best-effort. */
export function localAddresses() {
  return {
    loopback: "127.0.0.1",
    tailscale: tailscaleAddress(),
  };
}

/** CLI entry when run directly: keep the process alive while forwarding. */
export function runCli(argv) {
  const listen = parseAddress(argv[2] ?? "127.0.0.1:3081");
  const target = parseAddress(argv[3] ?? "127.0.0.1:3081");
  const forwarder = forwardAddress(listen, target);
  const stop = () => forwarder.dispose().finally(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("disconnect", stop);
  return forwarder;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runCli(process.argv);
}
