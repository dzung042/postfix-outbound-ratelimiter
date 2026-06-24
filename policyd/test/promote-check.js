/* Demonstrates the warm-up -> active auto-promotion. Run from policyd/ with a
 * live Redis+MariaDB (see commands in DEPLOY). Exits cleanly. */
require('reflect-metadata');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'mysql://policyd:testpass123@127.0.0.1:3307/policyd';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6390';
process.env.REDIS_SENTINELS = '';
process.env.JWT_SECRET = 'this_is_a_test_jwt_secret_at_least_32_chars_long';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.WARMUP_DAYS = process.env.WARMUP_DAYS || '3';
process.env.TZ = 'Asia/Ho_Chi_Minh';

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { PolicyService } = require('../dist/policy/policy.service');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { ConfigCacheService } = require('../dist/policy/config-cache.service');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const data = (email) => ({ protocol_state: 'DATA', sasl_username: email, sender: email, recipient_count: '1', queue_id: 'Q', client_address: '1.2.3.4' });

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const policy = app.get(PolicyService);
  const prisma = app.get(PrismaService);
  const cache = app.get(ConfigCacheService);
  await sleep(800);
  console.log(`WARMUP_DAYS = ${process.env.WARMUP_DAYS}\n`);

  // Case 1: sender created 5 days ago, still warmup, no explicit tier -> sending now should promote.
  const oldE = 'old@x.com';
  const fiveDaysAgo = new Date(Date.now() - 5 * 86400000);
  await prisma.sender.upsert({
    where: { email: oldE },
    update: { status: 'warmup', firstSeen: fiveDaysAgo, tierId: null },
    create: { email: oldE, domain: 'x.com', status: 'warmup', firstSeen: fiveDaysAgo },
  });
  cache.invalidateSender(oldE);
  const b = await prisma.sender.findUnique({ where: { email: oldE } });
  console.log(`[old, firstSeen 5d ago]  before send: status=${b.status}`);
  await policy.decide(data(oldE));
  await sleep(500); // promotion is async
  const a = await prisma.sender.findUnique({ where: { email: oldE } });
  console.log(`[old, firstSeen 5d ago]  after  send: status=${a.status}   (expect active)\n`);

  // Case 2: brand-new sender -> stays warmup (age < WARMUP_DAYS).
  const freshE = 'fresh@x.com';
  await prisma.sender.deleteMany({ where: { email: freshE } });
  cache.invalidateSender(freshE);
  await policy.decide(data(freshE)); // lazy-creates as warmup
  await sleep(400);
  await policy.decide(data(freshE)); // sends again, still young
  await sleep(400);
  const f = await prisma.sender.findUnique({ where: { email: freshE } });
  console.log(`[fresh, just created]    after sends: status=${f ? f.status : 'none'}   (expect warmup)\n`);

  // Summary table by status.
  const grp = await prisma.sender.groupBy({ by: ['status'], _count: { _all: true } });
  console.log('status distribution:', grp.map((g) => `${g.status}=${g._count._all}`).join(', '));

  await app.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
