# syntax=docker/dockerfile:1.7
# Build context: repository root.
#   docker build -f packages/runner/Dockerfile -t mates-runner .
#
# Toolchain per §7.1: Debian slim, git, curl, jq, ca-certificates, Node 22,
# Python 3.12, pnpm, pip, Claude Code CLI pinned. Runs as uid 1000.

FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/api/package.json packages/api/
COPY packages/ui/package.json packages/ui/
COPY packages/runner/package.json packages/runner/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter mates-runner...
COPY packages packages
RUN pnpm --filter mates-runner... build

FROM python:3.12-slim-bookworm
ARG CLAUDE_CODE_VERSION=2.1.303
ARG PNPM_VERSION=10.29.3
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl jq ca-certificates openssh-client \
 && rm -rf /var/lib/apt/lists/*
# Node 22 from the official image of the same Debian release (multi-arch safe).
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && npm install -g "pnpm@${PNPM_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && claude --version
COPY --from=build /src/packages/runner/dist/mates-run.js /usr/local/bin/mates-run
RUN useradd --uid 1000 --create-home --home-dir /home/mate --shell /bin/bash mate \
 && mkdir -p /workspace && chown 1000:1000 /workspace
USER 1000:1000
ENV HOME=/home/mate \
    GIT_TERMINAL_PROMPT=0 \
    PIP_NO_CACHE_DIR=1 \
    PNPM_HOME=/home/mate/.pnpm \
    PATH=/home/mate/.local/bin:/home/mate/.pnpm:/usr/local/bin:/usr/bin:/bin
WORKDIR /workspace
ENTRYPOINT ["mates-run"]
