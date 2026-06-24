import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { RedisService } from '../redis/redis.service';

export type AlertLevel = 'info' | 'warn' | 'critical';

/**
 * Fan-out alerts to Telegram and/or a generic webhook (e.g. a chat/automation flow).
 * De-duplicated via Redis so a storm of identical events sends one message.
 * Uses global fetch (Node >= 18). Never throws into the caller.
 */
@Injectable()
export class NotifyService {
  private readonly log = new Logger('Notify');

  constructor(
    private readonly cfg: AppConfig,
    private readonly redis: RedisService,
  ) {}

  async alert(
    level: AlertLevel,
    title: string,
    body: string,
    dedupeKey?: string,
  ): Promise<void> {
    try {
      if (dedupeKey) {
        const first = await this.redis
          .firstInWindow(`alert:${dedupeKey}`, this.cfg.alertMinIntervalSec)
          .catch(() => true);
        if (!first) return;
      }
      const icon = level === 'critical' ? '\u{1F6A8}' : level === 'warn' ? '⚠️' : 'ℹ️';
      const text = `${icon} *${title}*\n${body}`;
      await Promise.allSettled([this.sendTelegram(text), this.sendWebhook(level, title, body)]);
    } catch (e) {
      this.log.warn(`alert failed: ${(e as Error).message}`);
    }
  }

  private async sendTelegram(text: string): Promise<void> {
    if (!this.cfg.telegramBotToken || !this.cfg.telegramChatId) return;
    const url = `https://api.telegram.org/bot${this.cfg.telegramBotToken}/sendMessage`;
    await this.fetchJson(url, {
      chat_id: this.cfg.telegramChatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  }

  private async sendWebhook(level: AlertLevel, title: string, body: string): Promise<void> {
    if (!this.cfg.alertWebhookUrl) return;
    await this.fetchJson(this.cfg.alertWebhookUrl, {
      service: 'ratelimit-policyd',
      level,
      title,
      message: body,
      ts: new Date().toISOString(),
    });
  }

  private async fetchJson(url: string, payload: unknown): Promise<void> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
  }
}
