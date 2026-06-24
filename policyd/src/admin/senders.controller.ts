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
import { ConfigCacheService } from '../policy/config-cache.service';
import { SenderControlService } from '../policy/sender-control.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from './auth/jwt.guard';
import { ListSendersQuery, SenderDto, SuspendDto } from './dto';

@UseGuards(JwtAuthGuard)
@Controller('senders')
export class SendersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: ConfigCacheService,
    private readonly control: SenderControlService,
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
    const [items, total] = await Promise.all([
      this.prisma.sender.findMany({
        where,
        orderBy: { lastSeen: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.sender.count({ where }),
    ]);
    return { items, total };
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
