import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { RedisService, WindowSpec } from '../redis/redis.service';
import type { EffectiveLimits } from './config-cache.service';
import { ConfigCacheService } from './config-cache.service';
import { Bucket, buckets, counterKey, WindowName } from './windows';

export interface RateCheck {
  allowed: boolean;
  // present when !allowed
  window?: WindowName | 'msg';
  scope?: 'email' | 'domain';
  current?: number;
  limit?: number;
}

/**
 * Enforces the per-sender and per-domain multi-window limits atomically in one
 * Redis round-trip. This is the hot path for every outbound message.
 */
@Injectable()
export class RateLimitService {
  constructor(
    private readonly redis: RedisService,
    private readonly cache: ConfigCacheService,
    private readonly cfg: AppConfig,
  ) {}

  async check(
    email: string,
    domain: string,
    recipientCount: number,
    eff: EffectiveLimits,
    now: Date,
  ): Promise<RateCheck> {
    const b = buckets(now);

    // Map each scope's window to the resolved limit. limit <= 0 means "unlimited"
    // for that window and is simply not enforced (key omitted).
    const emailLimits: Array<[WindowName, number]> = [
      ['m1', eff.perMin],
      ['h1', eff.perHour],
      ['d1', eff.perDay],
      ['mo', eff.perMonth],
    ];
    const dom = this.cache.domainLimits(domain);
    const domainLimits: Array<[WindowName, number]> = [
      ['h1', dom.perHour],
      ['d1', dom.perDay],
    ];

    const specs: WindowSpec[] = [];
    const meta: Array<{ scope: 'email' | 'domain'; window: WindowName }> = [];

    for (const [w, limit] of emailLimits) {
      if (limit > 0) {
        specs.push({ key: counterKey('email', email, b[w]), limit, ttl: b[w].ttl });
        meta.push({ scope: 'email', window: w });
      }
    }
    for (const [w, limit] of domainLimits) {
      if (limit > 0) {
        specs.push({ key: counterKey('domain', domain, b[w]), limit, ttl: b[w].ttl });
        meta.push({ scope: 'domain', window: w });
      }
    }

    // Count mode: 'recipients' (default) adds the recipient count to each window;
    // 'messages' adds 1 per email (fan-out is then bounded only by maxRcptMsg).
    const inc = this.cfg.rateCountMode === 'messages' ? 1 : recipientCount;
    const res = await this.redis.rlCheck(specs, inc);
    if (res.allowed) {
      void this.updateLeaderboard(email, domain, b);
      return { allowed: true };
    }

    // res.index is the 0-based position in `specs` (and thus `meta`).
    const m =
      res.index >= 0 && res.index < meta.length
        ? meta[res.index]
        : { scope: 'email' as const, window: 'h1' as WindowName };
    return { allowed: false, scope: m.scope, window: m.window, current: res.current, limit: res.limit };
  }

  /** Best-effort, non-blocking: feed the dashboard "top near quota" leaderboards. */
  private async updateLeaderboard(email: string, domain: string, b: Record<WindowName, Bucket>) {
    try {
      const [m1, h1, d1] = await Promise.all([
        this.redis.getNum(counterKey('email', email, b.m1)),
        this.redis.getNum(counterKey('email', email, b.h1)),
        this.redis.getNum(counterKey('email', email, b.d1)),
      ]);
      await Promise.all([
        this.redis.leaderboard('email', 'm1', email, m1, b.m1.ttl),
        this.redis.leaderboard('email', 'h1', email, h1, b.h1.ttl),
        this.redis.leaderboard('email', 'd1', email, d1, b.d1.ttl),
      ]);
      await this.redis.markActive(email);
    } catch {
      /* best-effort */
    }
  }
}
