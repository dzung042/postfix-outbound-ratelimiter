import { Injectable } from '@nestjs/common';

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function fnum(v: string | undefined, def: number): number {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : def;
}
function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v);
}
function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Typed, validated view over process.env. Instantiated once and injected
 * everywhere. Kept dependency-free (no @nestjs/config) for a small footprint.
 */
@Injectable()
export class AppConfig {
  readonly policyPort = num(process.env.POLICY_PORT, 10032);
  readonly policyBind = process.env.POLICY_BIND || '0.0.0.0';
  readonly httpPort = num(process.env.HTTP_PORT, 8080);
  readonly metricsPort = num(process.env.METRICS_PORT, 9100);
  readonly allowCidrs = list(process.env.POLICY_ALLOW_CIDRS);

  // Redis
  readonly redisSentinels = list(process.env.REDIS_SENTINELS).map((hp) => {
    const [host, port] = hp.split(':');
    return { host, port: num(port, 26379) };
  });
  readonly redisMasterName = process.env.REDIS_MASTER_NAME || 'ratemaster';
  readonly redisPassword = process.env.REDIS_PASSWORD || undefined;
  readonly redisDb = num(process.env.REDIS_DB, 0);
  readonly redisKeyPrefix = process.env.REDIS_KEY_PREFIX || 'rl:';
  readonly redisUrl = process.env.REDIS_URL || '';

  // Decision behaviour
  readonly deferCode = num(process.env.DEFER_CODE, 451);
  readonly deferText = process.env.DEFER_TEXT || '4.7.1 Rate limit exceeded, please retry later';
  readonly rejectCode = num(process.env.REJECT_CODE, 554);
  readonly rejectText =
    process.env.REJECT_TEXT || '5.7.1 Sending temporarily disabled (suspected abuse)';
  readonly failAction = (process.env.FAIL_ACTION || 'DUNNO').toUpperCase();

  // Defaults / warm-up
  readonly defaultTier = process.env.DEFAULT_TIER || 'default';
  readonly warmupTier = process.env.WARMUP_TIER || 'warmup';
  readonly warmupDays = num(process.env.WARMUP_DAYS, 3);
  readonly perMessageRcptCap = num(process.env.PER_MESSAGE_RCPT_CAP, 100);

  // Anomaly
  readonly anomalyEnabled = bool(process.env.ANOMALY_ENABLED, true);
  // 'observe' = detect + alert + risk score but DO NOT suspend (safe rollout);
  // 'enforce' = also auto-suspend + hard bounce when the threshold is crossed.
  readonly anomalyMode = (process.env.ANOMALY_MODE || 'observe').toLowerCase();
  readonly anomalyBurstPerMin = num(process.env.ANOMALY_BURST_PER_MIN, 120);
  readonly anomalyDistinctRcptPerMin = num(process.env.ANOMALY_DISTINCT_RCPT_PER_MIN, 80);
  readonly anomalyOffhoursStart = num(process.env.ANOMALY_OFFHOURS_START, 1);
  readonly anomalyOffhoursEnd = num(process.env.ANOMALY_OFFHOURS_END, 5);
  readonly anomalyOffhoursPerMin = num(process.env.ANOMALY_OFFHOURS_PER_MIN, 40);
  readonly anomalyFlagsToSuspend = num(process.env.ANOMALY_FLAGS_TO_SUSPEND, 3);
  readonly anomalyWindowSec = num(process.env.ANOMALY_WINDOW_SEC, 600);

  // Admin auth
  readonly adminUser = process.env.ADMIN_USER || 'admin';
  readonly adminPassword = process.env.ADMIN_PASSWORD || '';
  readonly jwtSecret = process.env.JWT_SECRET || '';
  readonly jwtTtl = process.env.JWT_TTL || '8h';

  // Feedback loop (B): delivery-outcome ingest -> bounce/spam-rate -> flag/suspend.
  readonly feedbackToken = process.env.FEEDBACK_TOKEN || '';
  readonly bounceRateMinSample = num(process.env.BOUNCE_RATE_MIN_SAMPLE, 20);
  readonly bounceRateThreshold = fnum(process.env.BOUNCE_RATE_THRESHOLD, 0.3); // 0..1
  readonly feedbackWindowHours = num(process.env.FEEDBACK_WINDOW_HOURS, 24);

  // Notifications
  readonly telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
  readonly telegramChatId = process.env.TELEGRAM_CHAT_ID || '';
  readonly alertWebhookUrl = process.env.ALERT_WEBHOOK_URL || '';
  readonly alertMinIntervalSec = num(process.env.ALERT_MIN_INTERVAL_SEC, 300);

  // Ops
  readonly logLevel = process.env.LOG_LEVEL || 'info';
  readonly eventSampleOk = num(process.env.EVENT_SAMPLE_OK, 0);

  validateOrThrow(): void {
    const errs: string[] = [];
    if (!this.jwtSecret || this.jwtSecret.length < 16)
      errs.push('JWT_SECRET must be set and >= 16 chars');
    if (!this.adminPassword) errs.push('ADMIN_PASSWORD must be set');
    if (this.redisSentinels.length === 0 && !this.redisUrl)
      errs.push('Provide REDIS_SENTINELS or REDIS_URL');
    if (errs.length) throw new Error('Config error: ' + errs.join('; '));
  }
}
