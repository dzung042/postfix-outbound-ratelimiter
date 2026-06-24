import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ConfigCacheService } from '../policy/config-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from './auth/jwt.guard';
import { TierDto } from './dto';

@UseGuards(JwtAuthGuard)
@Controller('tiers')
export class TiersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: ConfigCacheService,
  ) {}

  @Get()
  list() {
    return this.prisma.tier.findMany({ orderBy: { id: 'asc' } });
  }

  @Post()
  async create(@Body() dto: TierDto) {
    const row = await this.prisma.tier.create({ data: dto });
    await this.cache.publishReload();
    return row;
  }

  @Put(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: TierDto) {
    const row = await this.prisma.tier.update({ where: { id }, data: dto });
    await this.cache.publishReload();
    return row;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.prisma.tier.delete({ where: { id } });
    await this.cache.publishReload();
  }
}
