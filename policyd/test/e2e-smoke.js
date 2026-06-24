/* In-process e2e: boots the Nest context (no TCP/HTTP), drives PolicyService and
 * FeedbackService directly against live Redis+MariaDB, asserts, exits. Run twice
 * with TESTMODE=observe|enforce. */
require('reflect-metadata');
process.env.DATABASE_URL = 'mysql://policyd:testpass123@127.0.0.1:3307/policyd';
process.env.REDIS_SENTINELS = '';
process.env.REDIS_URL = 'redis://127.0.0.1:6390';
process.env.JWT_SECRET = 'this_is_a_test_jwt_secret_at_least_32_chars_long';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.ANOMALY_BURST_PER_MIN = '5';
process.env.ANOMALY_FLAGS_TO_SUSPEND = '2';
process.env.ANOMALY_DISTINCT_RCPT_PER_MIN = '3';
process.env.FEEDBACK_TOKEN = 'secrettoken123';
process.env.BOUNCE_RATE_MIN_SAMPLE = '3';
process.env.BOUNCE_RATE_THRESHOLD = '0.5';
process.env.FEEDBACK_WINDOW_HOURS = '24';
process.env.ANOMALY_MODE = process.env.TESTMODE || 'observe';

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { PolicyService } = require('../dist/policy/policy.service');
const { FeedbackService } = require('../dist/feedback/feedback.service');
const { RedisService } = require('../dist/redis/redis.service');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { ConfigCacheService } = require('../dist/policy/config-cache.service');

let fails = 0;
function ok(cond, msg) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; }
const data = (email, rcpt, qid) => ({
  protocol_state: 'DATA', sasl_username: email, sender: email,
  recipient_count: String(rcpt), queue_id: qid, client_address: '203.0.113.9',
});

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const policy = app.get(PolicyService);
  const feedback = app.get(FeedbackService);
  const redis = app.get(RedisService);
  const prisma = app.get(PrismaService);
  const cache = app.get(ConfigCacheService);
  await new Promise((r) => setTimeout(r, 800)); // let redis/cache settle
  const vip = await prisma.tier.findUnique({ where: { name: 'vip' } });
  const mode = process.env.ANOMALY_MODE;
  console.log(`\n===== MODE=${mode} =====`);

  if (mode === 'observe') {
    const email = 'blast@x.com';
    await prisma.sender.upsert({
      where: { email },
      update: { tierId: vip.id, perMin: 1000, perHour: 100000, status: 'active' },
      create: { email, domain: 'x.com', tierId: vip.id, perMin: 1000, perHour: 100000, status: 'active', persist: true },
    });
    cache.invalidateSender(email);
    const res = [];
    for (let i = 1; i <= 4; i++) res.push(await policy.decide(data(email, 2, 'B' + i)));
    ok(res.every((r) => r === 'DUNNO'), `observe: all 4 msgs allowed (DUNNO) -> ${res.join(',')}`);
    ok((await redis.isSuspended(email)) === false, 'observe: sender NOT suspended (blocklist empty)');
    const top = await redis.riskTop(10);
    const me = top.find((t) => t.member === email);
    ok(me && me.risk > 0, `observe: risk score recorded -> ${me ? me.risk : 'none'}`);
  } else {
    const email = 'reput@x.com';
    await prisma.sender.upsert({
      where: { email },
      update: { tierId: vip.id, perMin: 1000, perHour: 100000, status: 'active' },
      create: { email, domain: 'x.com', tierId: vip.id, perMin: 1000, perHour: 100000, status: 'active', persist: true },
    });
    cache.invalidateSender(email);
    const sent = [];
    for (let i = 1; i <= 4; i++) sent.push(await policy.decide(data(email, 1, 'R' + i)));
    ok(sent.every((r) => r === 'DUNNO'), `enforce: 4 good msgs allowed -> ${sent.join(',')}`);
    const ing = await feedback.ingest([
      { sender: email, status: 'bounced', dsn: '5.1.1' },
      { sender: email, status: 'bounced', dsn: '5.7.1', text: 'spam blocked' },
      { sender: email, status: 'bounced', dsn: '5.1.1' },
    ]);
    ok(ing.accepted === 3, `enforce: ingested 3 feedback events -> ${JSON.stringify(ing)}`);
    await new Promise((r) => setTimeout(r, 200));
    ok((await redis.isSuspended(email)) === true, 'enforce: high bounce-rate -> sender SUSPENDED');
    const after = await policy.decide(data(email, 1, 'RX'));
    ok(/^554/.test(after), `enforce: next mail hard-bounced -> ${after}`);
    const rates = await feedback.ratesFor(email);
    ok(rates.bounce + rates.spam === 3 && rates.sent === 4, `enforce: rates sent=${rates.sent} bad=${rates.bounce + rates.spam} badRate=${rates.badRate.toFixed(2)}`);
  }

  await app.close();
  console.log(fails === 0 ? '\nRESULT: ALL PASS' : `\nRESULT: ${fails} FAIL`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
