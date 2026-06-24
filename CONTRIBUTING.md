# Contributing

Thanks for your interest! Issues, ideas, and pull requests are all welcome.

## Local development

```bash
cd policyd
npm install
npx prisma generate
npm run build         # type-check + compile
```

You need a Redis and a MySQL/MariaDB to run the service. The quickest way is the
full stack:

```bash
cp .env.example .env  # edit secrets
docker compose up -d --build
```

Or run just the dependencies and the service locally — see the smoke-test
section in [DEPLOY.md](DEPLOY.md) for exact commands.

## Tests

In-process smoke tests live in `policyd/test/` and exercise the real services
against a live Redis + MariaDB (no MTA needed):

```bash
# from policyd/, with Redis on :6390 and MariaDB on :3307 (see DEPLOY.md)
TESTMODE=observe node test/e2e-smoke.js
TESTMODE=enforce node test/e2e-smoke.js
node test/promote-check.js
```

## Coding standards

- TypeScript, NestJS conventions; keep modules small and focused.
- Keep shell/config files (`*.sh`, `*.conf`, `Dockerfile`, `.env*`, `*.yml`)
  **ASCII-only** to avoid locale breakage under Alpine/distroless/systemd.
- Don't commit secrets. `.env` is git-ignored; never hardcode credentials.
- Run `npm run build` before opening a PR so the type-check passes.

## Good first issues

- English translation of `ARCHITECTURE.md` / `DEPLOY.md`.
- Additional MTA integrations / examples.
- Alternative rate-limit algorithms (GCRA / token-bucket is stubbed in `redis/lua-scripts.ts`).
- Kubernetes / Helm deployment.
- Unit tests around `windows.ts`, `config-cache.service.ts`, `anomaly.service.ts`.

## Pull requests

1. Fork & branch (`feat/...`, `fix/...`).
2. Keep changes focused; describe the what and why.
3. Make sure `npm run build` is green.
4. Be kind in reviews. 🙂
