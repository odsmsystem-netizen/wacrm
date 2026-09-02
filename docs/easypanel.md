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

## Troubleshooting

**Build fails naming a missing variable.** That variable is absent or
empty in **Environment**. Add them and deploy again.

**The app loads but sign-in fails, or the browser console shows
Supabase errors.** The running image was built before the Supabase
variables were set, so the client bundle has empty values. A restart
will not fix it — press **Deploy** for a fresh build.

**502 / bad gateway.** The domain's target port is not `3000`, or a
stray `PORT` variable moved the listener.

**Build runs out of memory.** `next build` is the heavy step; a
server with less than ~2 GB of free RAM can be killed mid-build. Add
swap or build on a larger instance.
