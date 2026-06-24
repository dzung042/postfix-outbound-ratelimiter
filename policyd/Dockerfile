# syntax=docker/dockerfile:1
# Multi-stage build for the NestJS policy service.
# Stage 1: install deps + build TS + generate Prisma client.
FROM node:22.13-bookworm-slim AS build
WORKDIR /app
ENV NODE_ENV=development
# openssl + ca-certificates so `prisma generate` detects the correct engine
# target (OpenSSL 3.0 on bookworm) and can download engines over TLS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
# No lockfile shipped in the template; use npm install. In production, commit
# package-lock.json and switch to "npm ci" for reproducible builds.
RUN npm install --no-audit --no-fund
COPY tsconfig.json nest-cli.json ./
COPY prisma ./prisma
RUN npx prisma generate
COPY src ./src
COPY public ./public
RUN npm run build

# Stage 2: slim runtime image, prod deps only.
FROM node:22.13-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# openssl is required by the Prisma query engine at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl wget \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY prisma ./prisma
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh \
  && useradd -r -u 10001 -m policyd \
  && chown -R policyd:policyd /app
USER policyd
# 10032 = Postfix policy protocol (TCP), 8080 = admin API + UI, 9100 = Prometheus metrics
EXPOSE 10032 8080 9100
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:9100/healthz || exit 1
ENTRYPOINT ["./docker-entrypoint.sh"]
