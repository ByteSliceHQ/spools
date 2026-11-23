# syntax=docker/dockerfile:1
# Production image: Bun serves the built TanStack Start app (server.prod.ts).
# Everything it remembers is in the services it is pointed at, so it needs no volume
# and any number of instances can run.

FROM oven/bun:1.4.5 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run build
# What the server runs with, without the tools that built it.
RUN rm -rf node_modules && bun install --frozen-lockfile --production

FROM oven/bun:1.4.5-slim
WORKDIR /app
ENV NODE_ENV=production \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    PORT=3000
COPY --from=build /app ./
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD bun -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "server.prod.ts"]
