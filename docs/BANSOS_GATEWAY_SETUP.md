# Bansos Gateway — Cloudflare Named Tunnel Setup

This document is the operator runbook for exposing the Bansos Gateway (the
public-facing subset of 9Router's `/v1` API, gated by `bns_...` keys and
restricted to `POST /v1/chat/completions` + `GET /v1/models`) at
**`api.priaoslo.web.id`**, using a Cloudflare Zero Trust **named** tunnel.

It does not cover creating Bansos users/keys or the kill switch — that's the
local-only admin dashboard (`/dashboard`, never reachable through this
tunnel — see "Why this is safe to expose" below). This document is only
about the network path: how a public hostname reaches your 9Router
instance without opening any port on your router.

## Before you start: named tunnel vs. the built-in "Tunnel" toggle

9Router's CLI tray app (`9router` → Settings → Tunnel ON/OFF) already
manages a `cloudflared` process, but that is a Cloudflare **quick tunnel**
(`cloudflared tunnel --url ...`). Quick tunnels:

- get a random, throwaway `https://<random-words>.trycloudflare.com`
  hostname every time they start;
- have no persistent identity — you cannot point DNS at one, and the
  hostname changes on every restart;
- are unrelated to any Cloudflare Zero Trust account/zone configuration.

**A quick tunnel cannot serve `api.priaoslo.web.id`, and no configuration
of the built-in toggle will make it do so.** The named tunnel this document
sets up is a separate, independent `cloudflared` invocation with its own
config file and its own persistent tunnel identity, registered against your
Cloudflare account and DNS. Leave the CLI's own tunnel toggle **off** while
running the named tunnel below — the two aren't related, and running both
against the same local port at once is redundant, not harmful, but only
adds confusion when debugging.

## Prerequisites

- A Cloudflare account with the `priaoslo.web.id` zone already added and
  active (nameservers delegated to Cloudflare) — Zero Trust named tunnels
  require you to own/manage the zone you're routing DNS into.
- `cloudflared` installed on the same Windows machine that runs the
  9Router server. Download the Windows installer/binary from Cloudflare
  (`cloudflared.exe`) and confirm it runs:

  ```bash
  cloudflared --version
  ```

- 9Router itself already built and runnable on this machine (`npm install`,
  `npm run build` from the repo root — see the root `CLAUDE.md` / `README.md`
  for the full build steps). This document assumes it's reachable at
  `http://127.0.0.1:20127` — see the port note immediately below before you
  copy any command verbatim.

### Port note — confirm before proceeding

This repo's own `npm run start` script hardcodes `next start --port 20127`
(`package.json`), so the production server started via `npm run build &&
npm run start` from the repo root listens on **20127** regardless of any
`PORT` env var — that's the port used throughout this document's examples.

If instead you run the server via the published `9router` CLI launcher
package, its default is **20128** unless you pass `--port`/`-p` yourself.
Whichever way you actually start the server, use *that* port as the
tunnel's origin — a mismatched origin port fails every request with a
connection-refused error from `cloudflared`, not a 9Router error.

## Step 1 — Authenticate `cloudflared` to your Cloudflare account

```bash
cloudflared tunnel login
```

This opens a browser to authorize `cloudflared` against your Cloudflare
account and lets you pick the `priaoslo.web.id` zone. It writes a
certificate to `~/.cloudflared/cert.pem` (on Windows,
`%USERPROFILE%\.cloudflared\cert.pem`) that every subsequent `cloudflared
tunnel` command uses to prove it's allowed to manage tunnels/DNS for that
zone.

## Step 2 — Create the named tunnel

```bash
cloudflared tunnel create bansos-gateway
```

This registers a new tunnel with a permanent UUID and writes a credentials
JSON file (e.g. `~/.cloudflared/<TUNNEL-UUID>.json`) — this file is the
tunnel's private key. Treat it like any other credential: never commit it,
never post it, back it up somewhere access-controlled if you want tunnel
continuity after reinstalling `cloudflared`.

## Step 3 — Write the tunnel config

Create `~/.cloudflared/config.yml` (Windows:
`%USERPROFILE%\.cloudflared\config.yml`):

```yaml
tunnel: bansos-gateway
credentials-file: C:\Users\<you>\.cloudflared\<TUNNEL-UUID>.json

ingress:
  - hostname: api.priaoslo.web.id
    service: http://127.0.0.1:20127
  - service: http_status:404
```

The trailing `http_status:404` catch-all is required by `cloudflared` — any
request that doesn't match a named `hostname` rule above it gets a plain
404 from the Cloudflare edge, never reaching your machine at all. Since
this tunnel only ever routes `api.priaoslo.web.id`, that's exactly the
behavior you want: nothing else this tunnel could ever proxy leaks through.

## Step 4 — Route DNS to the tunnel

```bash
cloudflared tunnel route dns bansos-gateway api.priaoslo.web.id
```

This creates a `CNAME` record for `api.priaoslo.web.id` in your Cloudflare
DNS pointing at `<TUNNEL-UUID>.cfargotunnel.com`, proxied through
Cloudflare (orange-cloud). All public traffic to that hostname now reaches
Cloudflare's edge first, which forwards it down the encrypted tunnel to
whichever machine is running `cloudflared` with this tunnel's credentials —
**no inbound port needs to be opened, forwarded, or exposed on your home
router at all**; `cloudflared` only ever makes outbound connections from
your machine to Cloudflare.

## Step 5 — Run the tunnel and verify

```bash
cloudflared tunnel run bansos-gateway
```

Leave this running in a terminal for a first smoke test (Ctrl+C stops it).
With 9Router itself running locally on the port from the config, a request
to `https://api.priaoslo.web.id/v1/models` should now reach the real
9Router process — see "Validation" below for the actual commands.

## Step 6 — Install both pieces as autostarting services

Two independent processes need to survive a reboot: `cloudflared` (the
tunnel) and the 9Router server itself. Neither restarts itself
automatically unless you set this up.

**`cloudflared` as a Windows service** (built into `cloudflared` itself,
not something 9Router provides):

```bash
cloudflared service install
```

Run this from an elevated (Administrator) shell, once, after the config
file from Step 3 is in place. It registers `cloudflared` as a genuine
Windows service that starts on boot and reads the same
`%USERPROFILE%\.cloudflared\config.yml` — after this, `cloudflared tunnel
run` from Step 5 is no longer needed manually; the service takes over.
Manage it with the ordinary Windows service commands
(`sc query cloudflared`, or the Services MMC snap-in) or Cloudflare's own
`cloudflared service uninstall` if you ever need to remove it.

**9Router server autostart:** this repo has no bundled Windows-service
installer for the server process itself. The supported way to have it
start automatically on login is the CLI's own tray mode: run the published
`9router` CLI, choose "Hide to Tray (Background)" from its menu, which both
launches the server and registers a login-item
(`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\9router.vbs`) that
relaunches it in tray mode on every Windows sign-in. If you instead run the
server directly via `npm run start` from this repo (see the port note
above), you're responsible for your own restart-on-boot mechanism (Task
Scheduler "At log on" trigger running the start command is the simplest
option) — there's no `npm run`-based service installer here either.

## Expected downtime — read this before you rely on this hostname

This is a tunnel to **one physical machine**, not a redundant cloud
deployment. `api.priaoslo.web.id` is only reachable while **all** of the
following are true at once:

- the Windows PC is powered on and not asleep/hibernating;
- the `cloudflared` service (Step 6) is running and its tunnel connection
  to Cloudflare's edge is healthy;
- the 9Router server process itself is running and responsive.

If the PC is off, asleep, loses its internet connection, or the 9Router
process has crashed/isn't running, requests to `api.priaoslo.web.id` will
fail (typically a Cloudflare 502/530 error page, distinct from any error
9Router itself would return) until the machine and both services are back
up. There is no failover, no queueing, and no other origin serving this
hostname — treat any consumer of this endpoint as dependent on this one
machine's uptime.

## No router configuration required

Because `cloudflared` only opens *outbound* connections from your machine
to Cloudflare's edge, none of this requires touching your router: no port
forwarding, no DMZ, no UPnP, no static WAN IP, no dynamic-DNS client. If
your ISP changes your IP address or you're behind CGNAT, this setup is
completely unaffected — Cloudflare never connects to your router or WAN IP
at all.

## Validation

Replace `bns_REDACTED` below with a real Bansos key retrieved from the
local admin dashboard (`http://localhost:20127/dashboard` → Bansos Gateway
→ create a key — the plaintext is shown exactly once at creation time).
**Never paste a real key into this document, a commit, an issue, or a chat
transcript** — treat it exactly like any other bearer credential.

```bash
# Should return the one-model catalog: {"object":"list","data":[{"id":"bansos/grok-4.5",...}]}
curl https://api.priaoslo.web.id/v1/models \
  -H "Authorization: Bearer bns_REDACTED"

# Should return a normal OpenAI-shaped chat completion response
curl https://api.priaoslo.web.id/v1/chat/completions \
  -H "Authorization: Bearer bns_REDACTED" \
  -H "Content-Type: application/json" \
  -d '{"model":"bansos/grok-4.5","messages":[{"role":"user","content":"ping"}],"stream":false}'
```

A `401` with `"invalid_api_key"` means the key is wrong/revoked; a `403`
means the key is valid but the owning Bansos user is disabled; a `429`
means the per-user rate or concurrency limit was hit; a `503` means the
gateway kill switch is currently off (see the dashboard's Bansos Gateway
panel). A `404` on any path other than the two above is expected — the
public hostname intentionally serves nothing else.

After a successful call, confirm it shows up exactly once in
`http://localhost:20127/dashboard/usage`, attributed to the Bansos user and
key you used, with provider `grok-cli` and internal model `gcli/grok-4.5`
(never the public `bansos/grok-4.5` name) — this is the same usage ledger
every other 9Router request writes to, just filterable by Bansos
user/key.

## Why this is safe to expose

`api.priaoslo.web.id` only ever reaches 9Router's Bansos branch — the
public-host gate (`src/dashboardGuard.js`, `src/lib/bansos/policy.js`)
checks the inbound `Host` header before anything else runs, and on this
hostname it accepts *only* `GET /v1/models` and `POST
/v1/chat/completions`, *only* with a valid, active `bns_...` key, routed
internally to a single fixed model. The dashboard, every other `/v1`
surface, and ordinary internal API keys are unreachable through this
tunnel regardless of what headers a client sends — the tunnel's `ingress`
config in Step 3 doesn't even know those routes exist; it forwards
everything for this hostname to the same local port, and 9Router's own
Host-based gate does the rest.
