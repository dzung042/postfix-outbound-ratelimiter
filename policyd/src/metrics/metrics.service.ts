import { Injectable } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Prometheus metrics. Names are referenced by the Grafana dashboard - keep them
 * stable. One registry, exposed on the metrics port at /metrics.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly decisions = new Counter({
    name: 'policyd_decisions_total',
    help: 'Policy decisions by action',
    labelNames: ['action'] as const, // allow|defer|reject|suspend|error
    registers: [this.registry],
  });
  readonly decisionDuration = new Histogram({
    name: 'policyd_decision_duration_seconds',
    help: 'Time to compute a policy decision',
    buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
    registers: [this.registry],
  });
  readonly recipients = new Counter({
    name: 'policyd_recipients_total',
    help: 'Total recipients processed',
    registers: [this.registry],
  });
  readonly overQuota = new Counter({
    name: 'policyd_over_quota_total',
    help: 'Over-quota events by window and scope',
    labelNames: ['window', 'scope'] as const,
    registers: [this.registry],
  });
  readonly suspensions = new Counter({
    name: 'policyd_suspensions_total',
    help: 'Senders auto-suspended',
    registers: [this.registry],
  });
  readonly observeWouldSuspend = new Counter({
    name: 'policyd_observe_would_suspend_total',
    help: 'Observe mode: cases that WOULD have suspended if enforcing',
    labelNames: ['source'] as const, // anomaly|bounce
    registers: [this.registry],
  });
  readonly feedback = new Counter({
    name: 'policyd_feedback_total',
    help: 'Delivery-outcome feedback events ingested',
    labelNames: ['outcome'] as const, // ok|bounce|spam|defer
    registers: [this.registry],
  });
  readonly anomalyFlags = new Counter({
    name: 'policyd_anomaly_flags_total',
    help: 'Anomaly flags raised by reason',
    labelNames: ['reason'] as const, // velocity|offhours|fanout
    registers: [this.registry],
  });
  readonly activeSenders = new Gauge({
    name: 'policyd_active_senders',
    help: 'Approx distinct senders in the last hour',
    registers: [this.registry],
  });
  readonly redisUp = new Gauge({
    name: 'policyd_redis_up',
    help: 'Redis reachable (1) or not (0)',
    registers: [this.registry],
  });
  readonly configReloads = new Counter({
    name: 'policyd_config_reloads_total',
    help: 'Config cache reloads',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
