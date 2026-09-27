# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 -- build the static bundle.
# ---------------------------------------------------------------------------
# Node 22 is the LTS line and the one this project's dependency set is pinned
# against. Deliberately not `node:alpine`: that is a floating tag, so two builds
# a month apart are not the same build. Deliberately not Node 25 either --
# odd-numbered releases fall outside the `engines.node` ranges of several
# packages in this lockfile, and the only TypeScript that pairs well with Node 25
# is TS 7, which no longer exports `lib/tsc`, the exact entry point `vue-tsc`
# resolves. See the README section on why TS stopped at 6.0.3.
FROM node:22-alpine AS build

WORKDIR /app

# pnpm 11's `verify-deps-before-run` otherwise decides the installed tree is
# stale, attempts to purge `node_modules`, and aborts because there is no TTY to
# ask. CI=true puts pnpm in its non-interactive mode, which suppresses both the
# prompt and the repair attempt.
ENV CI=true

# No NODE_ENV=production on purpose: that would make pnpm skip devDependencies,
# and the type-check gate below lives in one of them. The runtime stage gets its
# content through `COPY --from=build`, so it never inherits this environment.
#
# pnpm comes from a global `npm install -g`, not from corepack. corepack verifies
# the `packageManager` tarball against npm's registry signing keys, and those
# bundled keys have gone stale in enough corepack releases that it fails with
# `Cannot find matching keyid` on a machine that has never run corepack. A
# global install skips signature verification entirely, and pinned to an exact
# version it is just as reproducible. No @latest, which would defeat that.
RUN npm install -g pnpm@11.18.0

# `.npmrc` pins registry.npmmirror.com, which is the fast path from inside
# China. NPM_REGISTRY is empty by default so the tracked config stays the single
# source of truth; setting it overrides the mirror without editing a repo file.
ARG NPM_REGISTRY

# The manifests go in their own layer, ahead of every source file, so editing a
# component does not invalidate a dependency install. `.npmrc` is copied first
# and rewritten in the next step -- copying it again inside a later COPY would
# silently restore the original registry and undo the override.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# The registry override is applied to the copy, never to the tracked file, and it
# is the last thing that touches .npmrc -- a later COPY of .npmrc would restore
# the mirror and undo it without a word.
RUN if [ -n "${NPM_REGISTRY}" ]; then \
      sed -i "s|^registry=.*|registry=${NPM_REGISTRY}|" .npmrc; \
    fi

# A BuildKit cache mount keyed on `id` outlives the layer, so the pnpm
# content-addressable store is fetched once and every later build re-links from
# cache instead of hitting the network. The store location is passed as a flag
# rather than written into a config file: `pnpm config set` would rewrite the
# repository's own .npmrc, and this way the override is scoped to the one
# command that needs it.
# `pnpm-workspace.yaml` is part of this layer on purpose: it carries
# `allowBuilds: { playwright: false }`, and dropping it would re-enable
# playwright's postinstall, i.e. roughly 150 MB of browser binaries this project
# never uses.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

# `tsconfig.json`'s include list reaches `*.config.ts` and `test/**/*.ts`, so
# both config files and the whole test tree are real inputs to the build gate,
# not build noise. Copying only `vite.config.ts` would leave `vue-tsc` type
# checking a file the tsconfig can see but the filesystem cannot.
# `env.d.ts` is the Vite client type reference and belongs with the other
# root-level typing files. `scripts/` is deliberately absent: no QA entry point
# is reachable from the build, and shipping them would only enlarge the context.
COPY tsconfig.json vite.config.ts vitest.config.ts env.d.ts index.html ./
COPY src ./src
COPY public ./public
COPY test ./test

# `/` serves the app from the site root. Set `/sub/path/` (with both slashes) to
# host under a sub-path; Vite rewrites the asset URLs in index.html to match.
ARG VITE_BASE_PATH=/

# Split rather than `pnpm build`, for two reasons. First, `VITE_BASE_PATH` has to
# reach `vite build` as `--base`, and folding it into a package.json script would
# mean editing a tracked file per deployment target. Second, both binaries are
# invoked straight out of node_modules/.bin so pnpm's `verify-deps-before-run`
# wrapper is bypassed entirely -- in a fresh container it wants to reconcile the
# tree first, and it has no reason to distrust a tree that was just installed
# with --frozen-lockfile.
#
# The `vue-tsc --noEmit` half is the project's own build gate and is not
# optional. Dropping it would let a type error ship inside a working image.
RUN ./node_modules/.bin/vue-tsc --noEmit \
 && ./node_modules/.bin/vite build --base "$VITE_BASE_PATH"

# ---------------------------------------------------------------------------
# Stage 2 -- serve the static output. No node, no node_modules, no source.
# ---------------------------------------------------------------------------
# `stable` rather than a hard-pinned number, deliberately: a server-facing base
# image exists to pick up security releases, and pinning it means nginx patches
# only arrive alongside a code change. If policy demands an exact version, this
# is the single line to edit -- nothing in docker/ assumes a specific nginx
# release.
FROM nginx:stable-alpine AS runtime

# The stock image's main nginx.conf already provides the events/http context and
# includes /etc/nginx/conf.d/, so this replaces the image's default site and is
# the only file where `server` appears.
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/security-headers.conf /etc/nginx/snippets/security-headers.conf

COPY --from=build /app/dist /usr/share/nginx/html

# Drop the inherited entrypoint. The stock one execs every script in
# /docker-entrypoint.d/, and several of them edit files under /etc/nginx -- the
# IPv6 default and the worker_processes autotune both `sed` the config in place.
# docker-compose.yml sets `read_only: true`, so those writes fail against a
# read-only root and the container can die during startup instead of serving.
#
# `ENTRYPOINT []` clears the base image's ENTRYPOINT and nothing else, so CMD
# below supplies the full argv. This is the same `exec` the stock entrypoint
# performs once it is done rewriting config. Nothing is lost: this project uses
# no /etc/nginx/templates, so envsubst had nothing to do either.
ENTRYPOINT []
CMD ["nginx", "-g", "daemon off;"]

# Informational only -- the compose service maps the host port onto 80.
EXPOSE 80
