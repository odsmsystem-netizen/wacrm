# syntax=docker/dockerfile:1

# ---------------------------------------------------------------
# Stage 1 — install dependencies (cached until package*.json change)
# ---------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------
# Stage 2 — build
#
# NEXT_PUBLIC_* values are inlined into the client bundle at build
# time, so they must be provided as build args (docker-compose.yml
# forwards them from .env.local; PaaS builders such as Easypanel
# forward every service env var as a build arg — see docs/easypanel.md).
# Server-only secrets (service role key, ENCRYPTION_KEY,
# META_APP_SECRET, ...) are read at runtime and must NOT be baked
# into the image.
#
# Deliberately absent: `ARG SUPABASE_SERVICE_ROLE_KEY` and friends.
# A builder that forwards every env var can only reach the ones this
# file declares, so *not* declaring a secret is what keeps it out of
# the build layers and the image metadata. Do not add them.
# ---------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_APP_LOCALE=en
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_APP_LOCALE=$NEXT_PUBLIC_APP_LOCALE \
    NEXT_TELEMETRY_DISABLED=1

# Fail the build if any required public value is missing, naming the
# ones that are.
#
# Without this the build *succeeds* and the image looks healthy: the
# Supabase browser client reads `process.env.NEXT_PUBLIC_SUPABASE_URL!`
# (src/lib/supabase/client.ts) with a non-null assertion, so an empty
# string type-checks, gets inlined into the client bundle, and only
# blows up in the user's browser at sign-in. A red build is a much
# cheaper way to learn the panel is missing a variable.
#
# NEXT_PUBLIC_SITE_URL is on the list because a request-derived origin
# only exists where there *is* a request: the cron endpoints and any
# background worker build links with nothing to fall back on. It is
# optional for `next start`; for a container it is required.
RUN missing=""; \
    for var in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_SITE_URL; do \
      if [ -z "$(printenv "$var")" ]; then missing="$missing $var"; fi; \
    done; \
    if [ -n "$missing" ]; then \
      echo "ERROR: missing required build-time variable(s):$missing" >&2; \
      echo "       These are inlined into the client bundle; setting them only at runtime has no effect." >&2; \
      echo "       Docker:     pass one --build-arg per variable to docker build." >&2; \
      echo "       Compose:    set them in .env.local, then docker compose --env-file .env.local up --build" >&2; \
      echo "       Easypanel:  set them under Environment, then Deploy (see docs/easypanel.md)." >&2; \
      exit 1; \
    fi

RUN npm run build

# ---------------------------------------------------------------
# Stage 3 — minimal runtime (standalone output)
# ---------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -S nextjs && adduser -S nextjs -G nextjs

COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nextjs /app/public ./public

USER nextjs
EXPOSE 3000

# Lives here rather than only in docker-compose.yml so that plain
# `docker run` and PaaS builders (Easypanel, which never reads our
# compose file) get a health signal too. Reads PORT inside node so an
# overridden port stays in sync with what the server is listening on.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)).then((r)=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
