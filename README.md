# DSH Open Access

**DSH Open Access** is a standalone [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
bundle plugin that opens a `dsh web` profile up for trusted networks:

- **Keyless browser entry** — a first visit to `/` mints the signed browser
  session cookie by itself (`303` + `Set-Cookie`) instead of demanding the
  `?token=` launch URL.
- **Any LAN hostname** — forwarders let the harness answer on `127.0.0.1`
  (so `http://<machine-name>:<port>/` works on the host itself, where DNS
  maps the machine name to loopback) and the fence admits the machine's
  hostname as an authority.
- **Tailscale address** — the host's Tailscale IPv4 (`tailscale ip -4`) is
  detected, forwarded, and admitted, so `http://100.x.y.z:<port>/` works
  from anywhere on your tailnet.

One install, no wrapper scripts: the plugin does the patching, forwarding,
and trust-fence wiring from inside the harness, and undoes all of it when
removed.

**Names.** *DSH Open Access* is the display name — the title the plugin manager
shows, read from `locale/en.json`. The machine identifiers stay lowercase and
stable, because profiles and patches refer to them: the npm package is
`dsh-open-access`, the Cordis plugin name is `open-access`, the bundle patch
row is `id: open-access`, and the no-auth switch is the `DSH_OPEN_ACCESS`
environment variable.

```
⚠️ SECURITY: with noAuth enabled (the default), anyone who can reach the
   port owns the harness — its UI, its shell tools, its remote code
   execution. Serve it on a network you trust. That is the point of the
   plugin; keep it off the open internet.
```

## Requirements

- DeepSeek Harness `0.2.1-rc.5` (developed and tested against this version;
  the no-auth patch is anchored and refuses to touch a changed upstream)
- Node.js ≥ 22
- `tailscale` CLI on `PATH` for the Tailscale address (optional — without
  it the plugin simply skips that alias)

## Install

```sh
# from the profile that runs the web UI (dsh plugin manages this for you)
dsh plugin --profile web add dsh-open-access
```

or, by hand, in the profile's `package.json`:

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "dsh-open-access": "^0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-open-access"
      ]
    }
  }
}
```

then `dsh plugin --profile web install` and restart `dsh web`.

The bundle patch mounts the plugin with defaults; nothing else to configure.

## What it does at startup

1. **Patches** `@deepseek-ai/dsh-client-connection/lib/index.js` once:
   `authorizeIndex` learns to mint the same signed, authority-bound session
   cookie the token flow mints, for a plain `GET /`, guarded by an
   environment flag this plugin sets in its own process. The patch is
   idempotent and refuses unknown upstream shapes.
2. **Starts forwarders** for `127.0.0.1:<port>` and `<tailscale-ip>:<port>`,
   pointed at the address dsh actually bound. Bytes pass through untouched,
   so WebSocket upgrades work and dsh still sees the browser's original
   `Host` header.
3. **Extends the `/api` trust fence**: the running `connection` entry's
   `trustedHosts` gains the machine hostname (both plain and `.local`),
   the Tailscale IP, and anything you add. The bind address needs no entry;
   the fence already accepts it.

## Configuration

Target the `open-access` row from the profile's own `cordis.patch.yml`:

```yaml
- id: open-access
  config:
    noAuth: true                  # mint the cookie on first visit (default)
    aliasLoopback: true           # forward 127.0.0.1:<port> (default)
    aliasTailscale: true          # forward <tailscale-ip>:<port> (default)
    trustedHosts:                 # extra authorities, merged with detected
      - harness.example.com
```

All keys are optional; unset keys keep the defaults above.

To restore the token gate, set `noAuth: false` (then first visits need the
`?token=` URL again) or remove the plugin.

## Command-line start

`scripts/serve.mjs` is a convenience launcher that binds the first global
IPv4, applies the patch up front (so a failed patch is a failed start), and
execs `dsh web`:

```sh
npx dsh-open-access/serve.mjs            # or: node node_modules/dsh-open-access/scripts/serve.mjs
DASH_PORT=3081 node .../scripts/serve.mjs --port 3082 --host 10.0.0.7
```

## How access works per origin

| URL | Works because |
| --- | --- |
| `http://<bind-ip>:<port>/` | the harness bind itself |
| `http://<machine-name>:<port>/` on the host | loopback forwarder; hostname trusted |
| `http://<machine-name>.local:<port>/` | loopback forwarder; hostname trusted |
| `http://<tailscale-ip>:<port>/` | Tailscale forwarder; IP trusted |
| anything else | refused by the Host/Origin fence (403), and by the cookie's authority binding |

Session cookies stay authority-bound: a cookie minted for the LAN IP does
not work on the Tailscale origin and vice versa — each origin mints its own
on first visit.

## Known limits

- The forwarders are per-process and die with the profile; a restart
  re-creates them. A leftover forwarder from a crashed run keeps serving
  (it exits only when the port is taken or killed).
- Tailscale detection runs once at startup; starting the daemon afterwards
  needs a profile restart.
- The no-auth patch edits `node_modules`; any `npm install`/update restores
  pristine upstream — the plugin re-applies it at next activation.

## License

MIT
