import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { MetricsService } from '../metrics/metrics.service';
import { RedisService } from '../redis/redis.service';

export interface AnomalyResult {
  flags: string[]; // reasons raised this message
  risk: number; // 0..100 risk score for this sender right now
  flagCount: number; // rolling flag count in the window
  wouldSuspend: boolean; // accumulated flags crossed the suspend threshold
  suspend: boolean; // wouldSuspend AND mode === 'enforce'
}

// Per-reason severity contribution to the risk score.
const SEVERITY: Record<string, number> = {
  velocity: 25,
  fanout: 25,
  offhours: 20,
  bounce: 35, // raised by the feedback loop (B)
};

/**
 * Behavioural anomaly detection on top of the raw quotas. This is what catches a
 * compromised-but-within-quota account: a sudden velocity spike, a high fan-out
 * single message, or unusual off-hours blasting. Crossing the flag threshold
 * triggers an auto-suspend + hard bounce (a behavioural "Layer 2" defense).
 * All counters are short-TTL Redis keys.
 */
@Injectable()
export class AnomalyService {
  constructor(
    private readonly cfg: AppConfig,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  private minuteBucket(now: Date): string {
    return `${now.getFullYear()}${now.getMonth() + 1}${now.getDate()}${now.getHours()}${now.getMinutes()}`;
  }

  private isOffHours(now: Date): boolean {
    const h = now.getHours();
    const a = this.cfg.anomalyOffhoursStart;
    const b = this.cfg.anomalyOffhoursEnd;
    return a <= b ? h >= a && h <= b : h >= a || h <= b; // handles wrap past midnight
  }

  async evaluate(email: string, recipientCount: number, now: Date): Promise<AnomalyResult> {
    if (!this.cfg.anomalyEnabled)
      return { flags: [], risk: 0, flagCount: 0, wouldSuspend: false, suspend: false };

    const mb = this.minuteBucket(now);
    // Track per-minute recipients and message count for this sender.
    const [rcptMin, msgMin] = await Promise.all([
      this.redis.incrTtl(`an:rcpt:${email}:${mb}`, recipientCount, 120),
      this.redis.incrTtl(`an:msg:${email}:${mb}`, 1, 120),
    ]);

    const flags: string[] = [];
    const offHours = this.isOffHours(now);
    const velThreshold = offHours ? this.cfg.anomalyOffhoursPerMin : this.cfg.anomalyBurstPerMin;

    if (rcptMin > velThreshold) {
      flags.push(offHours ? 'offhours' : 'velocity');
    }
    // Fan-out: a single message addressed to an unusually large recipient set
    // (still under the hard per-message cap, but suspicious).
    if (recipientCount > this.cfg.anomalyDistinctRcptPerMin) {
      flags.push('fanout');
    }
    // Many distinct messages per minute is also a scripted-blast signal.
    if (msgMin > Math.max(30, this.cfg.anomalyBurstPerMin / 2)) {
      if (!flags.includes('velocity')) flags.push('velocity');
    }

    for (const f of flags) this.metrics.anomalyFlags.inc({ reason: f });

    let flagCount = await this.redis.getNum(`an:flags:${email}`);
    if (flags.length > 0) {
      flagCount = await this.redis.incrTtl(`an:flags:${email}`, 1, this.cfg.anomalyWindowSec);
    }

    const risk = this.score(flags, flagCount);
    await this.redis.riskSet(email, risk, this.cfg.anomalyWindowSec);

    const wouldSuspend = flagCount >= this.cfg.anomalyFlagsToSuspend;
    const suspend = wouldSuspend && this.cfg.anomalyMode === 'enforce';
    return { flags, risk, flagCount, wouldSuspend, suspend };
  }

  /** 0..100 risk score: severities of current flags + escalation from history. */
  private score(flags: string[], flagCount: number): number {
    let s = flags.reduce((acc, f) => acc + (SEVERITY[f] ?? 15), 0);
    s += Math.round((30 * flagCount) / Math.max(1, this.cfg.anomalyFlagsToSuspend));
    return Math.min(100, s);
  }

  /**
   * Raise a flag from an external signal (the feedback/bounce loop). Returns
   * whether the rolling flag count now warrants a suspend, plus the new risk.
   */
  async raiseFlag(
    email: string,
    reason: string,
  ): Promise<{ flagCount: number; risk: number; wouldSuspend: boolean; suspend: boolean }> {
    this.metrics.anomalyFlags.inc({ reason });
    const flagCount = await this.redis.incrTtl(`an:flags:${email}`, 1, this.cfg.anomalyWindowSec);
    const risk = this.score([reason], flagCount);
    await this.redis.riskSet(email, risk, this.cfg.anomalyWindowSec);
    const wouldSuspend = flagCount >= this.cfg.anomalyFlagsToSuspend;
    return { flagCount, risk, wouldSuspend, suspend: wouldSuspend && this.cfg.anomalyMode === 'enforce' };
  }
}
