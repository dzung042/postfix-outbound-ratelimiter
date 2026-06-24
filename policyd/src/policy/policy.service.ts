import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { MetricsService } from '../metrics/metrics.service';
import { NotifyService } from '../notify/notify.service';
import { RedisService } from '../redis/redis.service';
import { AnomalyService } from './anomaly.service';
import { ConfigCacheService } from './config-cache.service';
import { EventWriterService } from './event-writer.service';
import { RateLimitService } from './ratelimit.service';
import { SenderControlService } from './sender-control.service';

/** Parsed Postfix policy request attributes (subset we use). */
export interface PolicyRequest {
  protocol_state?: string;
  sasl_username?: string;
  sender?: string;
  recipient_count?: string;
  queue_id?: string;
  client_address?: string;
  client_name?: string;
}

@Injectable()
export class PolicyService {
  private readonly log = new Logger('Policy');

  constructor(
    private readonly cfg: AppConfig,
    private readonly redis: RedisService,
    private readonly cache: ConfigCacheService,
    private readonly rate: RateLimitService,
    private readonly anomaly: AnomalyService,
    private readonly control: SenderControlService,
    private readonly events: EventWriterService,
    private readonly metrics: MetricsService,
    private readonly notify: NotifyService,
  ) {}

  private deferAction(): string {
    return `${this.cfg.deferCode} ${this.cfg.deferText}`;
  }
  private rejectAction(): string {
    return `${this.cfg.rejectCode} ${this.cfg.rejectText}`;
  }

  /**
   * Decide the Postfix action for one request. Always returns a valid action
   * string; on any internal error it fails open (FAIL_ACTION, default DUNNO) so
   * the rate limiter can never halt mail flow.
   */
  async decide(req: PolicyRequest): Promise<string> {
    const end = this.metrics.decisionDuration.startTimer();
    try {
      // Only act at DATA, where recipient_count is known. Other stages pass.
      const state = (req.protocol_state || '').toUpperCase();
      const principal = (req.sasl_username || req.sender || '').trim().toLowerCase();
      if (state !== 'DATA' || !principal) {
        this.metrics.decisions.inc({ action: 'allow' });
        return 'DUNNO';
      }

      const email = principal;
      const domain = email.includes('@') ? email.split('@')[1] : email;
      const rcpt = Math.max(1, parseInt(req.recipient_count || '1', 10) || 1);
      const clientIp = req.client_address || '';
      const queueId = req.queue_id || '';
      const now = new Date();
      this.metrics.recipients.inc(rcpt);

      // 1) Hard blocklist (suspended) - fastest possible reject.
      if (await this.redis.isSuspended(email)) {
        this.metrics.decisions.inc({ action: 'reject' });
        this.events.push({
          email, domain, clientIp, window: '--', currentCnt: 0, limitCnt: 0,
          action: 'SUSPEND', queueId,
        });
        return this.rejectAction();
      }

      // 2) Resolve effective limits (tier/domain/sender + warm-up).
      const eff = await this.cache.resolve(email, domain);
      if (eff.status === 'suspended') {
        await this.redis.suspend(email).catch(() => undefined);
        this.metrics.decisions.inc({ action: 'reject' });
        this.events.push({
          email, domain, clientIp, window: '--', currentCnt: 0, limitCnt: 0,
          action: 'SUSPEND', queueId,
        });
        return this.rejectAction();
      }

      // 3) Per-message recipient cap. A single over-cap message cannot be fixed by
      //    retrying, so reject hard (5xx) rather than defer.
      if (eff.maxRcptMsg > 0 && rcpt > eff.maxRcptMsg) {
        this.metrics.decisions.inc({ action: 'reject' });
        this.metrics.overQuota.inc({ window: 'msg', scope: 'email' });
        this.events.push({
          email, domain, clientIp, window: 'msg', currentCnt: rcpt, limitCnt: eff.maxRcptMsg,
          action: 'REJECT', queueId,
        });
        return `${this.cfg.rejectCode} 5.7.1 Too many recipients in one message (max ${eff.maxRcptMsg})`;
      }

      // 4) Multi-window / multi-scope quota check (atomic).
      const rl = await this.rate.check(email, domain, rcpt, eff, now);
      if (!rl.allowed) {
        this.metrics.decisions.inc({ action: 'defer' });
        this.metrics.overQuota.inc({ window: rl.window || 'h1', scope: rl.scope || 'email' });
        this.events.push({
          email, domain, clientIp, window: rl.window || 'h1',
          currentCnt: rl.current || 0, limitCnt: rl.limit || 0, action: 'OVER_QUOTA', queueId,
        });
        return this.deferAction();
      }

      // The message passed quota -> accepted for sending. Count it for the
      // bounce-rate feedback loop (option B).
      void this.redis
        .fbIncr('sent', email, rcpt, this.cfg.feedbackWindowHours)
        .catch(() => undefined);

      // 5) Behavioural anomaly on the (now counted) volume.
      //    enforce: cross threshold -> auto-suspend + hard bounce.
      //    observe: detect + risk + alert, but allow (no bounce).
      const an = await this.anomaly.evaluate(email, rcpt, now);
      if (an.suspend) {
        await this.control.suspend(
          email,
          `auto: ${an.flags.join(',')} (flags=${an.flagCount})`,
          'auto',
        );
        this.metrics.decisions.inc({ action: 'suspend' });
        this.events.push({
          email, domain, clientIp, window: 'm1', currentCnt: an.flagCount,
          limitCnt: this.cfg.anomalyFlagsToSuspend, action: 'SUSPEND', queueId, risk: an.risk,
        });
        return this.rejectAction();
      }
      if (an.wouldSuspend) {
        // observe mode: would have suspended. Alert + record, but let mail through.
        this.metrics.observeWouldSuspend.inc({ source: 'anomaly' });
        this.events.push({
          email, domain, clientIp, window: 'm1', currentCnt: an.flagCount,
          limitCnt: this.cfg.anomalyFlagsToSuspend, action: 'OBSERVE', queueId, risk: an.risk,
        });
        void this.notify.alert(
          'warn',
          'Anomaly (observe mode - NOT suspended)',
          `${email}\nflags=${an.flags.join(',')} count=${an.flagCount} risk=${an.risk}\nSet ANOMALY_MODE=enforce to auto-suspend.`,
          `observe:${email}`,
        );
      } else if (an.flags.length > 0) {
        this.events.push({
          email, domain, clientIp, window: 'm1', currentCnt: an.flagCount,
          limitCnt: this.cfg.anomalyFlagsToSuspend, action: 'ANOMALY', queueId, risk: an.risk,
        });
      }

      // 6) Allowed.
      this.metrics.decisions.inc({ action: 'allow' });
      if (this.cfg.eventSampleOk > 0 && rcpt >= this.cfg.eventSampleOk) {
        this.events.push({
          email, domain, clientIp, window: 'h1', currentCnt: rcpt, limitCnt: eff.perHour,
          action: 'UPDATE', queueId, risk: an.risk,
        });
      }
      return 'DUNNO';
    } catch (e) {
      // Fail open: never let an internal error block mail.
      this.metrics.decisions.inc({ action: 'error' });
      this.log.error(`decide() failed, failing open: ${(e as Error).message}`);
      return this.cfg.failAction;
    } finally {
      end();
    }
  }
}
