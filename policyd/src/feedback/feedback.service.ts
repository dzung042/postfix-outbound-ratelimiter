import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { MetricsService } from '../metrics/metrics.service';
import { NotifyService } from '../notify/notify.service';
import { AnomalyService } from '../policy/anomaly.service';
import { EventWriterService } from '../policy/event-writer.service';
import { SenderControlService } from '../policy/sender-control.service';
import { RedisService } from '../redis/redis.service';
import { classify, Outcome } from './classify';

export interface DeliveryEvent {
  email?: string;
  sender?: string;
  status?: string;
  dsn?: string;
  text?: string;
  queueId?: string;
  clientIp?: string;
}

export interface FeedbackRates {
  sent: number;
  bounce: number;
  spam: number;
  defer: number;
  badRate: number; // (bounce+spam)/sent, 0..1
  windowHours: number;
}

/**
 * Bounce-rate feedback loop (option B). Ingests delivery outcomes (from an MTA
 * log shipper), tracks per-sender bounce/spam rate in Redis, and when a sender's
 * rate crosses the threshold with enough samples, raises an anomaly flag ->
 * suspend (enforce) or alert (observe). This is the reputation-based "Layer 2"
 * defense: catching a hijacked-but-within-quota account by its delivery reputation.
 */
@Injectable()
export class FeedbackService {
  private readonly log = new Logger('Feedback');

  constructor(
    private readonly cfg: AppConfig,
    private readonly redis: RedisService,
    private readonly anomaly: AnomalyService,
    private readonly control: SenderControlService,
    private readonly events: EventWriterService,
    private readonly metrics: MetricsService,
    private readonly notify: NotifyService,
  ) {}

  /** Ingest a batch of delivery outcomes. Returns how many were processed. */
  async ingest(batch: DeliveryEvent[]): Promise<{ accepted: number }> {
    let accepted = 0;
    for (const ev of batch) {
      const email = (ev.email || ev.sender || '').trim().toLowerCase();
      if (!email) continue;
      const outcome = classify(ev.status, ev.dsn, ev.text);
      await this.record(email, outcome, ev).catch((e) =>
        this.log.warn(`record failed for ${email}: ${(e as Error).message}`),
      );
      accepted++;
    }
    return { accepted };
  }

  private async record(email: string, outcome: Outcome, ev: DeliveryEvent): Promise<void> {
    this.metrics.feedback.inc({ outcome });
    await this.redis.fbIncr(outcome, email, 1, this.cfg.feedbackWindowHours);
    if (outcome !== 'bounce' && outcome !== 'spam') return;

    // A bad outcome: re-evaluate this sender's reputation.
    const r = await this.redis.fbRates(email, this.cfg.feedbackWindowHours);
    const bad = r.bounce + r.spam;
    if (r.sent < this.cfg.bounceRateMinSample) return; // not enough volume to judge
    const rate = bad / Math.max(1, r.sent);
    if (rate < this.cfg.bounceRateThreshold) return;

    const pct = Math.round(rate * 100);
    const domain = email.includes('@') ? email.split('@')[1] : email;
    const reason = `bounce-rate ${pct}% (${bad}/${r.sent} in ${this.cfg.feedbackWindowHours}h)`;
    const flag = await this.anomaly.raiseFlag(email, 'bounce');

    this.events.push({
      email, domain, clientIp: ev.clientIp || '',
      window: 'fb', currentCnt: bad, limitCnt: r.sent,
      action: 'BOUNCE_RATE', queueId: ev.queueId || '', risk: flag.risk,
    });

    if (flag.suspend) {
      await this.control.suspend(email, reason, 'auto');
      this.metrics.suspensions.inc();
    } else if (flag.wouldSuspend) {
      this.metrics.observeWouldSuspend.inc({ source: 'bounce' });
      await this.notify.alert(
        'warn',
        'High bounce-rate (observe mode - NOT suspended)',
        `${email}\n${reason}\nSet ANOMALY_MODE=enforce to auto-suspend.`,
        `bounce:${email}`,
      );
    } else {
      await this.notify.alert('warn', 'High bounce-rate', `${email}\n${reason}`, `bounce:${email}`);
    }
  }

  async ratesFor(email: string): Promise<FeedbackRates> {
    const r = await this.redis.fbRates(email.toLowerCase(), this.cfg.feedbackWindowHours);
    const bad = r.bounce + r.spam;
    return { ...r, badRate: r.sent > 0 ? bad / r.sent : 0, windowHours: this.cfg.feedbackWindowHours };
  }
}
