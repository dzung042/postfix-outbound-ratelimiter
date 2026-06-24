import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Prisma');

  async onModuleInit(): Promise<void> {
    // Do not crash the whole service if the DB is briefly unavailable at boot;
    // config falls back to cached/default tiers and mail keeps flowing.
    try {
      await this.$connect();
      this.log.log('DB connected');
    } catch (e) {
      this.log.warn(`DB connect deferred: ${(e as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
