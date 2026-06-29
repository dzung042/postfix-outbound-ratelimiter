import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppConfig } from '../config/app-config';
import { ConfigCacheService } from '../policy/config-cache.service';
import { SenderControlService } from '../policy/sender-control.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { JwtAuthGuard } from './auth/jwt.guard';
import { ListSendersQuery, SenderDto, SuspendDto } from './dto';

@UseGuards(JwtAuthGuard)
@Controller('senders')
export class SendersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: ConfigCacheService,
    private readonly control: SenderControlService,
    private readonly redis: RedisService,
    private readonly cfg: AppConfig,
  ) {}

  @Get()
  async list(@Query() q: ListSendersQuery) {
    const where: Prisma.SenderWhereInput = {};
    const VALID_STATUS = ['active', 'warmup', 'suspended'];
    if (q.status && VALID_STATUS.includes(q.status)) where.status = q.status as any;
    if (q.search) {
      where.OR = [{ email: { contains: q.search } }, { domain: { contains: q.search } }];
    }
    const page = q.page ?? 1;
    const pageSize = Math.min(q.pageSize ?? 50, 200);
    const [items, total, statusGroups] = await Promise.all([
      this.prisma.sender.findMany({
        where,
        orderBy: { lastSeen: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.sender.count({ where }),
      // Total user counts by status (global, unfiltered) for the summary strip.
      this.prisma.sender
        .groupBy({ by: ['status'], _count: { _all: true } })
        .catch(() => [] as { status: string; _count: { _all: number } }[]),
    ]);

    const stats = { total: 0, active: 0, warmup: 0, suspended: 0 };
    for (const g of statusGroups as { status: string; _count: { _all: number } }[]) {
      const cnt = g._count._all;
      stats.total += cnt;
      if (g.status in stats) (stats as any)[g.status] = cnt;
    }

    // Per-sender anomaly state -> "Would-suspend" flag. flagCount >= threshold is
    // the same condition the anomaly engine uses for AnomalyResult.wouldSuspend.
    const anom = await this.redis
      .senderAnomaly(items.map((it) => it.email))
      .catch(() => ({}) as Record<string, { risk: number; flags: number }>);
    const threshold = this.cfg.anomalyFlagsToSuspend;
    const enriched = items.map((it) => {
      const a = anom[it.email] || { risk: 0, flags: 0 };
      return { ...it, risk: a.risk, flags: a.flags, wouldSuspend: a.flags >= threshold };
    });

    return { items: enriched, total, stats, mode: this.cfg.anomalyMode };
  }

  @Post()
  async create(@Body() dto: SenderDto) {
    const domain = dto.domain || (dto.email.includes('@') ? dto.email.split('@')[1] : '');
    const row = await this.prisma.sender.upsert({
      where: { email: dto.email },
      update: { ...dto, domain },
      create: { ...dto, domain, status: dto.status ?? 'active' },
    });
    this.cache.invalidateSender(dto.email);
    await this.cache.publishReload();
    return row;
  }

  @Put(':email')
  async update(@Param('email') email: string, @Body() dto: SenderDto) {
    const { email: _omit, ...data } = dto;
    const row = await this.prisma.sender.update({ where: { email }, data });
    this.cache.invalidateSender(email);
    await this.cache.publishReload();
    return row;
  }

  @Post(':email/suspend')
  async suspend(@Param('email') email: string, @Body() dto: SuspendDto) {
    await this.control.suspend(email, dto.reason || 'manual admin suspend', 'admin');
    return this.prisma.sender.findUnique({ where: { email } });
  }

  @Post(':email/unsuspend')
  async unsuspend(@Param('email') email: string) {
    await this.control.unsuspend(email);
    return this.prisma.sender.findUnique({ where: { email } });
  }

  @Delete(':email')
  @HttpCode(204)
  async remove(@Param('email') email: string) {
    await this.prisma.sender.delete({ where: { email } });
    this.cache.invalidateSender(email);
  }
}
