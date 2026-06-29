/**
 * Seed default tiers. CREATE-ONLY: it inserts a tier only if it does not exist
 * yet, and NEVER overwrites an existing one. This is what makes admin edits in
 * the UI survive container restarts (RUN_SEED=true stays safe / self-healing:
 * it only re-creates a required base tier that was deleted, e.g. warmup/default).
 *
 * Numbers are recipients-per-window. 0 = that window is unlimited.
 * Defaults are conservative for outbound anti-spam; tune them via the admin UI.
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
    // update:{} = if the tier already exists, leave admin's values untouched.
    const before = await prisma.tier.findUnique({ where: { name: t.name } });
    await prisma.tier.upsert({
      where: { name: t.name },
      update: {}, // never overwrite existing tiers
      create: { ...t, enabled: true },
    });
    // eslint-disable-next-line no-console
    console.log(`[seed] tier ${t.name} ${before ? 'kept (already exists)' : 'created'}`);
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
