import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ConfigCacheService } from '../policy/config-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from './auth/jwt.guard';
import { DomainDto } from './dto';

@UseGuards(JwtAuthGuard)
@Controller('domains')
export class DomainsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: ConfigCacheService,
  ) {}

  @Get()
  list() {
    return this.prisma.domain.findMany({ orderBy: { domain: 'asc' } });
  }

  @Post()
  async create(@Body() dto: DomainDto) {
    const row = await this.prisma.domain.create({ data: dto });
    await this.cache.publishReload();
    return row;
  }

  @Put(':domain')
  async update(@Param('domain') domain: string, @Body() dto: DomainDto) {
    const { domain: _omit, ...data } = dto;
    const row = await this.prisma.domain.update({ where: { domain }, data });
    await this.cache.publishReload();
    return row;
  }

  @Delete(':domain')
  @HttpCode(204)
  async remove(@Param('domain') domain: string) {
    await this.prisma.domain.delete({ where: { domain } });
    await this.cache.publishReload();
  }
}
