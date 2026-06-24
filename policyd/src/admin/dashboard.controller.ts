import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { FeedbackService } from '../feedback/feedback.service';
import { ConfigCacheService } from '../policy/config-cache.service';
import type { WindowName } from '../policy/windows';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { JwtAuthGuard } from './auth/jwt.guard';

@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly cache: ConfigCacheService,
    private readonly cfg: AppConfig,
    private readonly feedback: FeedbackService,
  ) {}

  /** Cluster-wide stats: decision counts derived from the (shared) event log. */
  @Get('stats')
  async stats() {
    const since = new Date(Date.now() - 3600_000);
    let grouped: { action: string; _count: { _all: number } }[] = [];
    try {
      grouped = (await this.prisma.event.groupBy({
        by: ['action'],
        where: { ts: { gte: since } },
        _count: { _all: true },
      })) as any;
    } catch {
      grouped = [];
    }
    const c = (a: string) => grouped.find((g) => g.action === a)?._count._all ?? 0;
    const [redisUp, activeSenders, suspended] = await Promise.all([
      this.redis.ping(),
      this.redis.activeSenders().catch(() => 0),
      this.redis.suspendedCount().catch(() => 0),
    ]);
    return {
      decisions: {
        allow: c('UPDATE'),
        defer: c('OVER_QUOTA'),
        reject: c('REJECT'),
        suspend: c('SUSPEND'),
      },
      mode: this.cfg.anomalyMode, // 'observe' | 'enforce'
      observe: c('OBSERVE'), // would-have-suspended (observe mode), last hour
      bounceFlags: c('BOUNCE_RATE'), // high bounce-rate flags, last hour
      activeSenders,
      suspended,
      redisUp,
    };
  }

  /** Senders with the highest current risk score (observe mode / option A). */
  @Get('risk')
  async risk(@Query('limit') limit = '20') {
    const n = Math.min(Number(limit) || 20, 100);
    const rows = await this.redis.riskTop(n).catch(() => []);
    return rows.map((r) => ({ key: `email:${r.member}`, risk: r.risk }));
  }

  /** Bounce/spam-rate detail for one sender (option B). */
  @Get('feedback/:email')
  feedbackFor(@Param('email') email: string) {
    return this.feedback.ratesFor(email);
  }

  /** Senders closest to their quota in the chosen window (leaderboard + limits). */
  @Get('top')
  async top(@Query('window') window = 'h1', @Query('limit') limit = '20') {
    const n = Math.min(Number(limit) || 20, 100);
    // Special pseudo-window: 'risk' shows the risk-score leaderboard.
    if (window === 'risk') {
      const rows = await this.redis.riskTop(n).catch(() => []);
      return rows.map((r) => ({ key: `email:${r.member}`, used: r.risk, limit: 100, pct: r.risk }));
    }
    const w = (['m1', 'h1', 'd1'].includes(window) ? window : 'h1') as WindowName;
    const rows = await this.redis.topNear('email', w, n).catch(() => []);
    const out: { key: string; used: number; limit: number; pct: number }[] = [];
    for (const r of rows) {
      const email = r.member;
      const domain = email.includes('@') ? email.split('@')[1] : email;
      const eff = await this.cache.resolve(email, domain);
      const lim =
        w === 'm1' ? eff.perMin : w === 'd1' ? eff.perDay : eff.perHour;
      out.push({
        key: `email:${email}`,
        used: r.used,
        limit: lim,
        pct: lim > 0 ? Math.min(100, Math.round((r.used / lim) * 100)) : 0,
      });
    }
    return out;
  }
}
