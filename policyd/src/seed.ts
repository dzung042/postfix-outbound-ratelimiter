/**
 * Seed default tiers. Idempotent (upsert by unique name).
 * Numbers are recipients-per-window. 0 = that window is unlimited.
 *
 * These defaults are deliberately conservative for outbound anti-spam; adjust
 * per your customer base via the admin UI. They model what large senders do:
 * a low warm-up for new accounts, a sane default for normal users, and higher
 * vetted tiers for business/VIP.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TIERS = [
  // name        perMin perHour perDay perMonth maxRcptMsg
  { name: 'warmup', perMin: 5, perHour: 30, perDay: 100, perMonth: 1000, maxRcptMsg: 20 },
  { name: 'default', perMin: 20, perHour: 200, perDay: 1000, perMonth: 20000, maxRcptMsg: 100 },
  { name: 'business', perMin: 60, perHour: 1000, perDay: 10000, perMonth: 200000, maxRcptMsg: 200 },
  { name: 'vip', perMin: 200, perHour: 5000, perDay: 50000, perMonth: 1500000, maxRcptMsg: 500 },
];

async function main() {
  for (const t of TIERS) {
    await prisma.tier.upsert({
      where: { name: t.name },
      update: {
        perMin: t.perMin,
        perHour: t.perHour,
        perDay: t.perDay,
        perMonth: t.perMonth,
        maxRcptMsg: t.maxRcptMsg,
        enabled: true,
      },
      create: { ...t, enabled: true },
    });
    // eslint-disable-next-line no-console
    console.log(`[seed] tier ${t.name} ok`);
  }
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[seed] error', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
