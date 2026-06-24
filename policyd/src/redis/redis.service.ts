import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfig } from '../config/app-config';
import { GCRA, INCR_TTL, RL_CHECK } from './lua-scripts';

export interface WindowSpec {
  key: string; // logical counter key (prefix is added centrally here)
  limit: number; // > 0
  ttl: number; // seconds
}

export type RlResult =
  | { allowed: true }
  | { allowed: false; index: number; current: number; limit: number };

const BLOCKLIST_KEY = 'blocklist'; // SET of suspended sender emails

/**
 * Thin wrapper over two ioredis connections (commands + pub/sub) configured for
 * Sentinel HA. All rate-limit math happens here via atomic Lua.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Redis');
  private client!: Redis;
  private sub!: Redis;
  private _up = false;
  private readonly pfx: string;

  constructor(private readonly cfg: AppConfig) {
    this.pfx = cfg.redisKeyPrefix;
    // Build both connections in the constructor so they exist before any other
    // provider's onModuleInit (e.g. ConfigCache subscribing to pub/sub) runs.
    this.client = this.buildClient();
    this.sub = this.buildClient();
    this.client.defineCommand('rlcheck', { lua: RL_CHECK });
    this.client.defineCommand('incrttl', { numberOfKeys: 1, lua: INCR_TTL });
    this.client.defineCommand('gcra', { numberOfKeys: 1, lua: GCRA });
    this.client.on('ready', () => {
      this._up = true;
      this.log.log('Redis ready');
    });
    this.client.on('error', (e) => {
      this._up = false;
      this.log.warn(`Redis error: ${e.message}`);
    });
    this.client.on('end', () => (this._up = false));
  }

  get up(): boolean {
    return this._up;
  }

  /** Central key prefixing. We do NOT use ioredis keyPrefix because it does not
   *  reliably prefix dynamic-key Lua scripts. Prefix everything here instead. */
  private k(name: string): string {
    return this.pfx + name;
  }

  private buildClient(): Redis {
    const common = {
      password: this.cfg.redisPassword,
      db: this.cfg.redisDb,
      // Keep the policy path responsive: short, bounded retries; never block mail.
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
    };
    if (this.cfg.redisSentinels.length > 0) {
      return new Redis({
        sentinels: this.cfg.redisSentinels,
        name: this.cfg.redisMasterName,
        sentinelPassword: this.cfg.redisPassword,
        ...common,
      });
    }
    // Single-node fallback (dev).
    return new Redis(this.cfg.redisUrl || 'redis://127.0.0.1:6379', common);
  }

  async onModuleInit(): Promise<void> {
    // ioredis auto-connects in the background. We do not block startup on it:
    // the service must come up and fail-open even if Redis is briefly down.
    if (this.client.status === 'ready') this._up = true;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.client?.quit(), this.sub?.quit()]);
  }

  /** Atomic multi-window check-and-increment. Throws if Redis is unreachable. */
  async rlCheck(windows: WindowSpec[], inc: number): Promise<RlResult> {
    if (windows.length === 0) return { allowed: true };
    const keys = windows.map((w) => this.k(w.key));
    const args: (string | number)[] = [inc];
    for (const w of windows) args.push(w.limit, w.ttl);
    // Dynamic key count: pass keys.length as first positional arg.
    const res = (await (this.client as any).rlcheck(keys.length, ...keys, ...args)) as any[];
    if (Number(res[0]) === 1) return { allowed: true };
    // res[1] is the 1-based index of the offending window.
    return {
      allowed: false,
      index: Number(res[1]) - 1,
      current: Number(res[2]),
      limit: Number(res[3]),
    };
  }

  async incrTtl(key: string, inc: number, ttl: number): Promise<number> {
    return Number(await (this.client as any).incrttl(this.k(key), inc, ttl));
  }

  async getNum(key: string): Promise<number> {
    const v = await this.client.get(this.k(key));
    return v ? Number(v) : 0;
  }

  // --- blocklist (suspended senders) ---
  async isSuspended(email: string): Promise<boolean> {
    return (await this.client.sismember(this.k(BLOCKLIST_KEY), email)) === 1;
  }
  async suspend(email: string): Promise<void> {
    await this.client.sadd(this.k(BLOCKLIST_KEY), email);
  }
  async unsuspend(email: string): Promise<void> {
    await this.client.srem(this.k(BLOCKLIST_KEY), email);
  }
  async suspendedCount(): Promise<number> {
    return this.client.scard(this.k(BLOCKLIST_KEY));
  }

  // --- dashboard leaderboard (best-effort, bounded) ---
  /** Record current usage so the UI can show "top senders near quota". */
  async leaderboard(scope: string, window: string, member: string, used: number, ttl: number) {
    const z = this.k(`lb:${scope}:${window}`);
    try {
      await this.client
        .multi()
        .zadd(z, used, member)
        .expire(z, ttl)
        .zremrangebyrank(z, 0, -1001) // keep top 1000 by score
        .exec();
    } catch {
      /* leaderboard is best-effort */
    }
  }
  async topNear(scope: string, window: string, limit: number): Promise<{ member: string; used: number }[]> {
    const z = this.k(`lb:${scope}:${window}`);
    const rows = await this.client.zrevrange(z, 0, limit - 1, 'WITHSCORES');
    const out: { member: string; used: number }[] = [];
    for (let i = 0; i < rows.length; i += 2) out.push({ member: rows[i], used: Number(rows[i + 1]) });
    return out;
  }

  // --- risk leaderboard (observe mode / option A) ---
  async riskSet(email: string, risk: number, ttl: number): Promise<void> {
    const z = this.k('lb:risk:email');
    try {
      await this.client
        .multi()
        .zadd(z, risk, email)
        .expire(z, Math.max(ttl, 60))
        .zremrangebyrank(z, 0, -1001)
        .exec();
    } catch {
      /* best-effort */
    }
  }
  async riskTop(limit: number): Promise<{ member: string; risk: number }[]> {
    const z = this.k('lb:risk:email');
    const rows = await this.client.zrevrange(z, 0, limit - 1, 'WITHSCORES');
    const out: { member: string; risk: number }[] = [];
    for (let i = 0; i < rows.length; i += 2) out.push({ member: rows[i], risk: Number(rows[i + 1]) });
    return out;
  }

  // --- feedback / bounce-rate counters (option B) ---
  private fbBucket(windowHours: number): number {
    return Math.floor(Date.now() / 1000 / (windowHours * 3600));
  }
  async fbIncr(kind: string, email: string, n: number, windowHours: number): Promise<number> {
    const b = this.fbBucket(windowHours);
    return this.incrTtl(`fb:${kind}:${email}:${b}`, n, windowHours * 3600 + 300);
  }
  async fbRates(
    email: string,
    windowHours: number,
  ): Promise<{ sent: number; bounce: number; spam: number; defer: number }> {
    const b = this.fbBucket(windowHours);
    const keys = ['sent', 'bounce', 'spam', 'defer'].map((kind) =>
      this.k(`fb:${kind}:${email}:${b}`),
    );
    const vals = await this.client.mget(...keys);
    return {
      sent: Number(vals[0] || 0),
      bounce: Number(vals[1] || 0),
      spam: Number(vals[2] || 0),
      defer: Number(vals[3] || 0),
    };
  }

  // --- active-sender estimate via HyperLogLog (cheap, approximate) ---
  async markActive(email: string): Promise<void> {
    const bucket = this.k(`active:${Math.floor(Date.now() / 3600000)}`); // current hour
    try {
      const p = this.client.multi().pfadd(bucket, email).expire(bucket, 7200);
      await p.exec();
    } catch {
      /* best-effort */
    }
  }
  async activeSenders(): Promise<number> {
    const bucket = this.k(`active:${Math.floor(Date.now() / 3600000)}`);
    try {
      return Number(await this.client.pfcount(bucket));
    } catch {
      return 0;
    }
  }

  // --- pub/sub for config reloads + alert de-dupe ---
  async publish(channel: string, message: string): Promise<void> {
    await this.client.publish(channel, message);
  }
  async subscribe(channel: string, cb: (message: string) => void): Promise<void> {
    await this.sub.subscribe(channel);
    this.sub.on('message', (ch, msg) => {
      if (ch === channel) cb(msg);
    });
  }

  /** Returns true at most once per `ttl` seconds for a given dedupe key. */
  async firstInWindow(key: string, ttl: number): Promise<boolean> {
    const r = await this.client.set(this.k(`once:${key}`), '1', 'EX', ttl, 'NX');
    return r === 'OK';
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      this._up = true;
      return true;
    } catch {
      this._up = false;
      return false;
    }
  }
}
