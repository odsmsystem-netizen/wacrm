# Deploying on Easypanel

[Easypanel](https://easypanel.io) builds the `Dockerfile` in this repo
directly — it never reads `docker-compose.yml`, so the Compose setup
in [docker.md](docker.md) is for local use only. Supabase stays
external: point the app at your hosted (or self-hosted) project via
environment variables. No database service is needed on the server.

## 1. Create the service

In your project, add a service of type **App** and give it a name
(e.g. `wacrm`). Everything below happens in that service's tabs.

## 2. Source

Under **Source**, choose **GitHub**, enter the repository as
`owner/repo`, and pick the branch you deploy from. Leave **Build
Path** at `/` — it is the Docker build context, and the Dockerfile
copies from the repository root.

## 3. Build

Under **Build**, choose **Dockerfile** and leave the Dockerfile path
at `Dockerfile`.

## 4. Domains (before the first deploy)

Under **Domains**, add your hostname and set the **target port** to
`3000` with protocol HTTP — "the target port must be the port on
which the process listens inside the container", and the image fixes
that at 3000. Enable HTTPS.

Do this _before_ deploying: the hostname goes into
`NEXT_PUBLIC_SITE_URL` below, which is a build-time value. Setting it
afterwards costs you a second build.

## 5. Environment

This is the step that decides whether the deploy works, so it is
worth understanding rather than pasting blindly.

Easypanel "builds the image with Docker Buildx and passes project and
service environment values ... as build arguments", and a Dockerfile
only receives the ones it declares with `ARG`. This repo's Dockerfile
declares exactly four — the `NEXT_PUBLIC_*` ones — so you set
**everything in one place**, the **Environment** tab, and each value
automatically lands where it belongs: public values reach the build,
secrets reach only the running container.

Paste this in **Environment** (dotenv syntax), filling in your values:

```dotenv
# Reaches the build (inlined into the client bundle)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
NEXT_PUBLIC_SITE_URL=https://crm.example.com
NEXT_PUBLIC_APP_LOCALE=en

# Runtime only — never enters the image
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
ENCRYPTION_KEY=your-64-char-hex-key
META_APP_SECRET=your-meta-app-secret
```

See [`.env.local.example`](../.env.local.example) for what each value
is and the optional ones (`AUTOMATION_CRON_SECRET`, `META_APP_ID`,
the AI tuning vars).

All three of `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY` and `NEXT_PUBLIC_SITE_URL` are
required — the build refuses to run without them.

Do **not** set `PORT`. The image already listens on 3000 and binds
`0.0.0.0`; overriding it only desynchronises the app from the domain
target port below.

### Why the secrets are safe here

Easypanel forwards _every_ service variable to the builder, and its
own documentation warns that "Docker build arguments are not a secure
secret mechanism. A value can be exposed by a command, image
metadata, or a build layer." The defence is in the Dockerfile: it
deliberately declares no `ARG` for `SUPABASE_SERVICE_ROLE_KEY`,
`ENCRYPTION_KEY` or `META_APP_SECRET`, so those values are never
visible to any build instruction and never reach a layer. Adding an
`ARG` for one of them would silently undo this.

## 6. Deploy

Press **Deploy** and watch the build log. If a required public
variable is missing, the build stops early with an explicit error
instead of shipping a broken app:

```
ERROR: missing required build-time variable(s): NEXT_PUBLIC_SITE_URL
```

## Rebuild vs restart

| Change                    | What you need             |
| ------------------------- | ------------------------- |
| Any `NEXT_PUBLIC_*` value | **Deploy** (full rebuild) |
| Everything else           | Restart the service       |

`NEXT_PUBLIC_*` values are inlined into the JavaScript during
`npm run build`; editing them in the panel and restarting changes
nothing. This includes `NEXT_PUBLIC_APP_LOCALE`, which is surprising:
`src/i18n/request.ts` reads it on the _server_, but the
`NEXT_PUBLIC_` prefix means Next.js inlines it at build time anyway.
Switching languages requires a rebuild.

## After the first deploy

- **Database migrations are not run by the container.** Apply the
  files under `supabase/` with the Supabase CLI as described in the
  README, before or right after the first deploy.
- **Point the Meta webhook** at
  `https://<your-domain>/api/whatsapp/webhook`.
- **Schedule the cron endpoints if you use Wait steps or flows.**
  Easypanel has no built-in scheduler (its services are App, MySQL,
  MariaDB, Postgres, Mongo, Redis, WordPress, Box and Compose), so
  use a host crontab or an external pinger against
  `GET /api/automations/cron` and `GET /api/flows/cron`, sending
  `AUTOMATION_CRON_SECRET` in the `x-cron-secret` header. Both return
  503 until that variable is set.

## Self-hosting on a Windows host

Easypanel normally runs on a dedicated Linux VPS. When it runs on a
Windows machine instead — Docker Desktop with Swarm — three things a
VPS gives you for free have to be arranged by hand.

**Port 443 has to actually be free.** Traefik publishes it in `host`
mode, and Docker Desktop neither retries nor reports a failed bind: if
anything else already holds 443 when the container starts, `docker ps`
still prints `0.0.0.0:443->443/tcp` as though Traefik owned it. The
container looks healthy, the panel shows nothing wrong, and the site is
unreachable. Don't trust the port list — ask the port for its
certificate:

```bash
echo | openssl s_client -connect 127.0.0.1:443 -servername <your-domain> 2>/dev/null \
  | openssl x509 -noout -subject -issuer
```

If the issuer is not Let's Encrypt, something else is answering.

**Windows has to be told to accept the connection.** Docker Desktop
binds the port but creates no firewall rule, so Windows drops the
inbound SYN without a word. Run once, as administrator:

```
powershell -ExecutionPolicy Bypass -File scripts\open-https-port.ps1
```

You cannot catch this from the host itself: a request to `127.0.0.1` or
to the machine's own LAN address is loopback and never crosses the
inbound firewall, so every local test passes while every remote one
hangs. Test from another machine.

**Reaching the site from inside the same network.** Traefik routes by
Host header, so the domain is the only way in — the host's IP address
lands on Easypanel's own dashboard, not on the app. If the network has
no hairpin NAT, the public name resolves to an address that never comes
back, and the site is unreachable from the LAN while working perfectly
from outside. Map the name to the internal address on each machine that
needs it, in `C:\Windows\System32\drivers\etc\hosts`:

```
192.0.2.10    crm.example.com
```

The Let's Encrypt certificate stays valid, because the name still
matches. Remove the line if the app ever moves elsewhere: it silently
overrides DNS, and the machine will keep talking to the old host with
no hint as to why.

## Troubleshooting

**Build fails naming a missing variable.** That variable is absent or
empty in **Environment**. Add them and deploy again.

**The app loads but sign-in fails, or the browser console shows
Supabase errors.** The running image was built before the Supabase
variables were set, so the client bundle has empty values. A restart
will not fix it — press **Deploy** for a fresh build.

**502 / bad gateway.** The domain's target port is not `3000`, or a
stray `PORT` variable moved the listener.

**Nothing answers from the internet, but the perimeter firewall says
it allowed the traffic.** The connection is dying on the host, not in
transit. On a Palo Alto the sessions log as application `incomplete`
ending in `aged-out` with a couple of hundred bytes — the SYN arrived
and nothing replied. That is the host firewall; see _Self-hosting on a
Windows host_ above.

**The site works from outside but times out from the office.** No
hairpin NAT: the name resolves to the public address, the packet leaves
and never comes back. Use the `hosts` entry described above.

**The domain serves an unexpected certificate, or Easypanel's own
dashboard instead of the app.** Either another process holds 443, or
the request reached Traefik without a Host header matching a configured
domain.

**Build runs out of memory.** `next build` is the heavy step; a
server with less than ~2 GB of free RAM can be killed mid-build. Add
swap or build on a larger instance.
