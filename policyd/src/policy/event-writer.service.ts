import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface EventRow {
  email: string;
  domain: string;
  clientIp: string;
  window: string;
  currentCnt: number;
  limitCnt: number;
  action: string;
  queueId: string;
  risk?: number;
}

/**
 * Buffers audit events and flushes them in batches, so the hot path never does
 * one INSERT per mail. The buffer is bounded; on overflow the oldest entries are
 * dropped (audit is best-effort and must never back-pressure mail flow).
 */
@Injectable()
export class EventWriterService implements OnModuleInit, OnModuleDestroy {
  private buf: EventRow[] = [];
  private readonly MAX = 5000;
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), 2000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  push(row: EventRow): void {
    if (this.buf.length >= this.MAX) this.buf.shift();
    this.buf.push(row);
  }

  private async flush(): Promise<void> {
    if (this.buf.length === 0) return;
    const batch = this.buf;
    this.buf = [];
    try {
      await this.prisma.event.createMany({ data: batch });
    } catch {
      // DB unavailable: drop this batch rather than grow unbounded.
    }
  }
}
