import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import helmet from 'helmet';
import * as http from 'http';
import { join } from 'path';
import { AppModule } from './app.module';
import { AppConfig } from './config/app-config';
import { MetricsService } from './metrics/metrics.service';
import { PolicyTcpServer } from './policy/policy-tcp.server';
import { RedisService } from './redis/redis.service';

// Prisma BigInt ids are not JSON-serializable by default; make them numbers.
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

async function bootstrap(): Promise<void> {
  const log = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
  });

  const cfg = app.get(AppConfig);
  cfg.validateOrThrow();

  app.use(helmet({ contentSecurityPolicy: false })); // CSP off so the inline SPA loads
  app.enableShutdownHooks();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
  );

  // Static admin UI (served at root; API lives under /api).
  const pub = join(__dirname, '..', 'public');
  app.use(express.static(pub));

  await app.listen(cfg.httpPort, '0.0.0.0');
  log.log(`admin API + UI on :${cfg.httpPort} (UI at /, API at /api)`);

  // Postfix policy-delegation TCP server.
  const tcp = app.get(PolicyTcpServer);
  await tcp.listen();

  // Metrics + health on a separate port (scraped by Prometheus; used by healthcheck).
  const metrics = app.get(MetricsService);
  const redis = app.get(RedisService);
  const metricsServer = http.createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', redis: redis.up }));
      return;
    }
    if (req.url === '/metrics') {
      metrics.redisUp.set(redis.up ? 1 : 0);
      try {
        metrics.activeSenders.set(await redis.activeSenders());
      } catch {
        /* ignore */
      }
      res.writeHead(200, { 'content-type': metrics.registry.contentType });
      res.end(await metrics.render());
      return;
    }
    res.writeHead(404);
    res.end();
  });
  metricsServer.listen(cfg.metricsPort, '0.0.0.0', () =>
    log.log(`metrics + health on :${cfg.metricsPort} (/metrics, /healthz)`),
  );

  const shutdown = async () => {
    log.log('shutting down...');
    await tcp.close().catch(() => undefined);
    metricsServer.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error:', e);
  process.exit(1);
});
