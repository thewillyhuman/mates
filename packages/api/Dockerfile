# syntax=docker/dockerfile:1.7
# Build context: repository root (the workspace is needed to resolve @mates/*).
#   docker build -f packages/api/Dockerfile -t mates-api .

FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/api/package.json packages/api/
COPY packages/ui/package.json packages/ui/
COPY packages/runner/package.json packages/runner/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter mates-api... --filter mates-ui...
COPY packages packages
RUN pnpm --filter mates-ui build && pnpm --filter mates-api... build
# Flatten the API and its workspace deps into a self-contained tree.
RUN pnpm --filter mates-api --prod deploy --legacy /out/api \
 && cp -r packages/api/public /out/api/public

# Distroless: no shell, non-root (uid 65532), node as entrypoint.
FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build /out/api /app
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["dist/main.js"]
