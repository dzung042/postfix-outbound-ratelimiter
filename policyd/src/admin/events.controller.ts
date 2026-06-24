import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from './auth/jwt.guard';

@UseGuards(JwtAuthGuard)
@Controller('events')
export class EventsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query('email') email?: string,
    @Query('action') action?: string,
    @Query('limit') limit?: string,
  ) {
    const where: Prisma.EventWhereInput = {};
    if (email) where.email = { contains: email };
    if (action) where.action = action;
    const take = Math.min(Number(limit) || 100, 1000);
    const rows = await this.prisma.event.findMany({ where, orderBy: { ts: 'desc' }, take });
    // BigInt id is made JSON-safe by the global BigInt.toJSON shim in main.ts.
    return rows;
  }
}
