import { Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '../metrics/metrics.service';
import { NotifyService } from '../notify/notify.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ConfigCacheService } from './config-cache.service';

/**
 * Single source of truth for suspending / un-suspending a sender. Keeps the
 * Redis blocklist (fast path), the DB row (durable + UI), and the in-memory
 * cache consistent, and fires an alert. Used by both the policy hot path
 * (auto-suspend on anomaly) and the admin API (manual action).
 */
@Injectable()
export class SenderControlService {
  private readonly log = new Logger('SenderControl');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly cache: ConfigCacheService,
    private readonly metrics: MetricsService,
    private readonly notify: NotifyService,
  ) {}

  async suspend(email: string, reason: string, source: 'auto' | 'admin'): Promise<void> {
    const domain = email.split('@')[1] || '';
    // Fast path first so further mail is blocked immediately, even if the DB lags.
    await this.redis.suspend(email).catch(() => undefined);
    this.cache.invalidateSender(email);
    this.metrics.suspensions.inc();
    try {
      await this.prisma.sender.upsert({
        where: { email },
        update: { status: 'suspended', reason },
        create: { email, domain, status: 'suspended', reason },
      });
    } catch (e) {
      this.log.warn(`suspend DB write failed for ${email}: ${(e as Error).message}`);
    }
    await this.notify.alert(
      'critical',
      `Sender suspended (${source})`,
      `${email}\nReason: ${reason}`,
      `suspend:${email}`,
    );
    this.log.warn(`SUSPEND ${email} (${source}): ${reason}`);
  }

  async unsuspend(email: string): Promise<void> {
    await this.redis.unsuspend(email).catch(() => undefined);
    this.cache.invalidateSender(email);
    try {
      await this.prisma.sender.update({
        where: { email },
        data: { status: 'active', reason: null },
      });
    } catch (e) {
      this.log.warn(`unsuspend DB write failed for ${email}: ${(e as Error).message}`);
    }
  }
}
