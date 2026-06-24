import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Domain, Sender, Tier } from '@prisma/client';
import { AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

export const CFG_RELOAD_CHANNEL = 'cfg:reload';

export interface EffectiveLimits {
  perMin: number;
  perHour: number;
  perDay: number;
  perMonth: number;
  maxRcptMsg: number;
  tierName: string;
  status: 'active' | 'warmup' | 'suspended';
}

interface SenderCacheEntry {
  row: Sender | null; // null = known-absent (negative cache)
  at: number;
}

/**
 * In-memory resolver for effective limits. Tiers + domains (small, bounded) are
 * fully cached and refreshed periodically / on pub-sub. Senders (potentially
 * millions) are cached in a bounded LRU with TTL; only active senders occupy it.
 *
 * Resolution precedence: sender override > domain override > tier > built-in default.
 */
@Injectable()
export class ConfigCacheService implements OnModuleInit {
  private readonly log = new Logger('ConfigCache');

  private tiersByName = new Map<string, Tier>();
  private tiersById = new Map<number, Tier>();
  private domains = new Map<string, Domain>();

  private readonly senderLru = new Map<string, SenderCacheEntry>();
  private readonly SENDER_TTL_MS = 60_000;
  private readonly SENDER_MAX = 100_000;

  constructor(
    private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reloadGlobal();
    // Refresh tiers/domains every 30s as a safety net even without pub-sub.
    setInterval(() => this.reloadGlobal().catch(() => undefined), 30_000).unref();
    // Instant reload when an admin saves a change (any replica).
    await this.redis
      .subscribe(CFG_RELOAD_CHANNEL, () => this.reloadGlobal().catch(() => undefined))
      .catch((e) => this.log.warn(`pub/sub subscribe failed: ${e.message}`));
  }

  async reloadGlobal(): Promise<void> {
    try {
      const [tiers, domains] = await Promise.all([
        this.prisma.tier.findMany(),
        this.prisma.domain.findMany(),
      ]);
      this.tiersByName = new Map(tiers.map((t) => [t.name, t]));
      this.tiersById = new Map(tiers.map((t) => [t.id, t]));
      this.domains = new Map(domains.map((d) => [d.domain, d]));
      this.senderLru.clear(); // sender overrides may reference changed tiers
    } catch (e) {
      this.log.warn(`reloadGlobal failed (using stale cache): ${(e as Error).message}`);
    }
  }

  /** Notify all replicas (including self) to reload. Call after any admin write. */
  async publishReload(): Promise<void> {
    await this.redis.publish(CFG_RELOAD_CHANNEL, '1').catch(() => undefined);
  }

  private getTier(name: string): Tier | undefined {
    return this.tiersByName.get(name);
  }

  private async getSender(email: string): Promise<Sender | null> {
    const hit = this.senderLru.get(email);
    if (hit && Date.now() - hit.at < this.SENDER_TTL_MS) {
      // refresh LRU recency
      this.senderLru.delete(email);
      this.senderLru.set(email, hit);
      return hit.row;
    }
    let row: Sender | null = null;
    try {
      row = await this.prisma.sender.findUnique({ where: { email } });
    } catch {
      // DB hiccup: fall back to stale entry if any, else treat as absent.
      return hit?.row ?? null;
    }
    this.putSender(email, row);
    return row;
  }

  private putSender(email: string, row: Sender | null): void {
    if (this.senderLru.size >= this.SENDER_MAX) {
      const oldest = this.senderLru.keys().next().value;
      if (oldest !== undefined) this.senderLru.delete(oldest);
    }
    this.senderLru.set(email, { row, at: Date.now() });
  }

  /** Drop one sender from cache (after an admin edit or suspend). */
  invalidateSender(email: string): void {
    this.senderLru.delete(email);
  }

  /**
   * Resolve the effective limits for a sender. Lazily registers brand-new
   * senders on the warm-up tier (async, non-blocking).
   */
  async resolve(email: string, domain: string): Promise<EffectiveLimits> {
    const sender = await this.getSender(email);

    // Brand-new sender: register lazily on warm-up, do not block the decision.
    if (!sender) {
      this.lazyCreateSender(email, domain);
      return this.fromTier(this.cfg.warmupTier, 'warmup');
    }

    if (sender.status === 'suspended') {
      return { ...this.fromTier(this.cfg.defaultTier, 'suspended'), status: 'suspended' };
    }

    const dom = this.domains.get(domain);
    if (dom && dom.enabled === false) {
      // Admin disabled the whole domain -> treat as blocked.
      return { ...this.fromTier(this.cfg.defaultTier, 'suspended'), status: 'suspended' };
    }

    // Warm-up promotion: graduate after WARMUP_DAYS.
    let status = sender.status as EffectiveLimits['status'];
    const ageDays = (Date.now() - new Date(sender.firstSeen).getTime()) / 86_400_000;
    if (status === 'warmup' && ageDays > this.cfg.warmupDays) {
      status = 'active';
      this.promoteSender(email); // async
    }

    // Base tier: sender.tier -> domain.tier -> warmup/default by status.
    const baseTierName =
      (sender.tierId && this.tiersById.get(sender.tierId)?.name) ||
      (dom?.tierId && this.tiersById.get(dom.tierId)?.name) ||
      (status === 'warmup' ? this.cfg.warmupTier : this.cfg.defaultTier);

    const eff = this.fromTier(baseTierName, status);

    // Domain-level overrides (apply to the per-domain scope but also tighten user).
    if (dom?.perHour != null) eff.perHour = dom.perHour;
    if (dom?.perDay != null) eff.perDay = dom.perDay;

    // Sender-level overrides win.
    if (sender.perMin != null) eff.perMin = sender.perMin;
    if (sender.perHour != null) eff.perHour = sender.perHour;
    if (sender.perDay != null) eff.perDay = sender.perDay;
    if (sender.perMonth != null) eff.perMonth = sender.perMonth;

    return eff;
  }

  /** Effective per-domain limits (the second enforcement scope). */
  domainLimits(domain: string): { perHour: number; perDay: number } {
    const dom = this.domains.get(domain);
    const tier =
      (dom?.tierId && this.tiersById.get(dom.tierId)) || this.getTier(this.cfg.defaultTier);
    return {
      perHour: dom?.perHour ?? 0, // 0 = no explicit domain cap unless set
      perDay: dom?.perDay ?? 0,
    };
    // Note: domain caps are opt-in (set perHour/perDay on the domain) so we do
    // not accidentally throttle whole domains by inheriting per-user tier numbers.
  }

  private fromTier(name: string, status: EffectiveLimits['status']): EffectiveLimits {
    const t = this.getTier(name) || this.getTier(this.cfg.defaultTier);
    return {
      perMin: t?.perMin ?? 0,
      perHour: t?.perHour ?? 0,
      perDay: t?.perDay ?? 0,
      perMonth: t?.perMonth ?? 0,
      maxRcptMsg: t?.maxRcptMsg ?? this.cfg.perMessageRcptCap,
      tierName: t?.name ?? name,
      status,
    };
  }

  private lazyCreateSender(email: string, domain: string): void {
    // Cache a negative entry immediately so we do not stampede the DB.
    this.putSender(email, null);
    this.prisma.sender
      .upsert({
        where: { email },
        update: { lastSeen: new Date() },
        create: { email, domain, status: 'warmup' },
      })
      .then((row) => this.putSender(email, row))
      .catch(() => undefined);
  }

  private promoteSender(email: string): void {
    this.prisma.sender
      .update({ where: { email }, data: { status: 'active' } })
      .then(() => this.invalidateSender(email))
      .catch(() => undefined);
  }
}
