// DSH Open Access — keyless browser entry, LAN hostname access, and a
// Tailscale address alias for a DeepSeek Harness web profile.
//
// Three capabilities, one plugin:
//
// 1. noAuth — a first visit to / without a token mints the browser session
//    cookie by itself (HTTP 303 + Set-Cookie) instead of demanding the
//    launch token. Implemented as a tiny, anchored patch to
//    @deepseek-ai/dsh-client-connection's `authorizeIndex`, guarded by an
//    env var so uninstalling the plugin (or unsetting it per process)
//    restores the token gate without touching node_modules again.
//
// 2. aliases — byte-level TCP forwarders (lib/alias.js) that let 127.0.0.1
//    and the host's Tailscale address answer on the web port even though
//    the harness binds exactly one address. Hostname access on the host
//    itself (http://spark5:3081/ where /etc/hosts maps spark5 to
//    127.0.0.1) rides the loopback alias.
//
// 3. trustedHosts — every extra Host header the aliases can produce is
//    added to the /api browser-trust fence by patching the `connection`
//    entry's config: the machine hostname (as DNS resolves it on the
//    host, both ways) and the Tailscale IP. The dsh bind address is
//    always trusted implicitly and is never added here.
//
// Nothing here weakens the fence for strangers: only authorities that name
// this machine are admitted. But with noAuth the browser gate is gone by
// design — anyone who can reach the port owns the harness. Serve it on a
// network you trust.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import z from "@deepseek-ai/schemastery";
import { forwardAddress, localAddresses } from "./alias.js";

/** Stable Cordis plugin name. */
export const name = "open-access";

/** Human-facing plugin name; the plugin manager reads the same text from locale/en.json. */
export const title = "DSH Open Access";

/** Services this plugin waits for: the HTTP carrier and the browser transport. */
export const inject = ["webServer", "connection"];

/** Environment variable the no-auth patch checks at request time. */
export const NOAUTH_ENV = "DSH_OPEN_ACCESS";

const CONN_PKG = "@deepseek-ai/dsh-client-connection";
const PATCH_MARKER = "DSH_OPEN_ACCESS";

export const Config = z.object({
  /** Mint the session cookie on a plain first visit (no ?token=). */
  noAuth: z.boolean().default(true),
  /** Forward 127.0.0.1:<port> to the bind address (hostname-on-host access). */
  aliasLoopback: z.boolean().default(true),
  /** Forward <tailscale-ip>:<port> to the bind address (tailnet access). */
  aliasTailscale: z.boolean().default(true),
  /** Extra authorities (hosts) to admit besides hostname and Tailscale IP. */
  trustedHosts: z.array(z.string()).default([]),
}).default({});

// ── 1. no-auth patch ─────────────────────────────────────────────────────────

const ANCHOR = [
  "\tauthorizeIndex(req, res, secure = false) {",
  '\t\t/* v8 ignore next -- node:http always supplies url on server requests. */',
  '\t\tconst url = new URL(req.url ?? "/", "http://dsh.invalid");',
  "",
].join("\n");

function injectPatch() {
  return [
    "\t\t/* DSH Open Access: a plain first visit mints its own browser session",
    "\t\t * cookie instead of demanding the launch token, while the plugin set",
    `\t\t * ${PATCH_MARKER}=1 in this process. Same signed cookie, same`,
    "\t\t * authority binding and trust checks as the token flow. */",
    `\t\tif (process.env.${PATCH_MARKER} === "1" && req.method === "GET" && url.pathname === "/" && !this.isAuthenticated(req, secure)) {`,
    "\t\t\tconst authority = requestAudience(req.headers, secure);",
    "\t\t\tif (authority !== void 0) {",
    "\t\t\t\tconst issuedAt = Date.now();",
    "\t\t\t\tconst expiresAt = issuedAt + this.maxAgeMilliseconds;",
    "\t\t\t\tconst value = encodeCookie({ version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt }, this.secret);",
    "\t\t\t\tres.writeHead(303, {",
    '\t\t\t\t\t"cache-control": "no-store",',
    '\t\t\t\t\t"location": "./",',
    '\t\t\t\t\t"referrer-policy": "no-referrer",',
    '\t\t\t\t\t"set-cookie": sessionCookie(cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1e3), secure)',
    "\t\t\t\t});",
    "\t\t\t\tres.end();",
    "\t\t\t\treturn false;",
    "\t\t\t}",
    "\t\t}",
    "",
  ].join("\n");
}

/**
 * Apply the no-auth patch to the installed dsh-client-connection. Idempotent
 * and anchored: refuses to edit a source whose shape it does not recognize.
 * @returns {string} a human-readable result line
 */
export function applyNoAuthPatch() {
  const require = createRequire(import.meta.url);
  // The lib file is not in the package exports map; find it through the
  // manifest, the way the harness resolves its own dist files.
  const manifestPath = require.resolve(`${CONN_PKG}/package.json`);
  const path = new URL(`./lib/index.js`, new URL(`file://${manifestPath}`)).pathname;
  const source = readFileSync(path, "utf8");
  if (source.includes(PATCH_MARKER)) return `${title}: no-auth patch already present`;
  const occurrences = source.split(ANCHOR).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${title}: expected exactly one authorizeIndex anchor in ${CONN_PKG}, found ${occurrences}; ` +
      "the installed dsh version changed — file an issue instead of forcing this patch",
    );
  }
  writeFileSync(path, source.replace(ANCHOR, ANCHOR + injectPatch()));
  return `${title}: patched ${CONN_PKG} authorizeIndex (remove the plugin or unset ${PATCH_MARKER} to restore the token gate)`;
}

// ── 2+3. aliases and trusted hosts ───────────────────────────────────────────

/** The webserver's listening port, or 3080 before it binds. */
function webPort(ctx) {
  return ctx.webServer?.port ?? 3080;
}

/** The webserver's bind address, or 127.0.0.1 before it binds. */
function webHost(ctx) {
  return ctx.webServer?.host ?? "127.0.0.1";
}

/** DNS names that reach this host from the host itself. */
function hostnameAuthorities() {
  const name = hostname();
  return name ? [name, `${name}.local`].filter((v, i, a) => a.indexOf(v) === i) : [];
}

/**
 * Plugin entry. Runs after webServer and connection exist: patches the auth
 * gate, patches the trust fence config, starts the aliases, and disposes of
 * everything when the profile stops.
 */
export async function apply(ctx, config) {
  const cfg = config ?? {};
  const logs = [];

  // 1. no-auth: patch node_modules once per install, then arm the env flag
  //    this process checks. Uninstalling the plugin removes the patch on the
  //    next apply (see restoreNoAuthPatch) and never arms the flag.
  if (cfg.noAuth !== false) {
    logs.push(applyNoAuthPatch());
    process.env[NOAUTH_ENV] = "1";
  } else {
    process.env[NOAUTH_ENV] = "0";
  }

  const target = { host: webHost(ctx), port: webPort(ctx) };
  const detected = localAddresses();
  const forwarders = [];

  // 2. aliases: loopback (hostname-on-host) and the Tailscale address.
  const aliasLoopback = cfg.aliasLoopback !== false;
  const aliasTailscale = cfg.aliasTailscale !== false && detected.tailscale !== undefined && detected.tailscale !== target.host;
  if (aliasLoopback && (target.host !== "127.0.0.1" || !aliasTailscale)) {
    forwarders.push(forwardAddress({ host: "127.0.0.1", port: target.port }, target, (m) => logs.push(m)));
  }
  if (aliasTailscale) {
    forwarders.push(forwardAddress({ host: detected.tailscale, port: target.port }, target, (m) => logs.push(m)));
  }
  ctx.effect(() => async () => {
    await Promise.allSettled(forwarders.map((f) => f.dispose()));
  }, `${name}: address aliases`);

  // 3. trusted hosts: every Host the aliases can produce plus the machine
  //    name, admitted by the /api fence through the connection entry config.
  //    The bind address needs no entry; the fence already accepts it.
  const wanted = new Set(cfg.trustedHosts ?? []);
  if (aliasLoopback) for (const host of hostnameAuthorities()) wanted.add(host);
  if (detected.tailscale) wanted.add(detected.tailscale);
  wanted.delete(target.host);
  const extra = [...wanted].filter(Boolean);
  if (extra.length > 0) await extendTrustedHosts(ctx, extra);
  for (const line of logs) console.log(line);
  if (extra.length > 0) {
    console.log(`${title}: trusted authorities: ${extra.join(", ")}`);
  }
  if (cfg.noAuth !== false) {
    console.log(`${title}: browser entry needs no token (remove the plugin, or start with config noAuth:false, to restore it)`);
  }
}

/**
 * Extend the running `connection` entry's trustedHosts with `hosts`,
 * preserving whatever was already configured. The entry restarts in place
 * through the Loader's own update path — the same mechanism the Plugins page
 * uses — so the profile YAML and any --patch overlays keep working untouched.
 */
async function extendTrustedHosts(ctx, hosts) {
  const loader = ctx.get("loader");
  if (loader === void 0) {
    console.warn(`${title}: no loader; cannot extend ${CONN_PKG} trustedHosts with ${JSON.stringify(hosts)}`);
    return;
  }
  for (const entry of loader.entries()) {
    if (entry?.options?.name !== CONN_PKG) continue;
    const previous = Array.isArray(entry.options.config?.trustedHosts) ? entry.options.config.trustedHosts : [];
    const merged = [...previous];
    for (const host of hosts) if (!merged.includes(host)) merged.push(host);
    if (merged.length === previous.length) return;
    await loader.update(entry.id, { config: { ...entry.options.config, trustedHosts: merged } });
    return;
  }
  console.warn(`${title}: no ${CONN_PKG} entry found to extend with trustedHosts ${JSON.stringify(hosts)}`);
}
