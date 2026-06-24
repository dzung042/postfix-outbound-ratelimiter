import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module';
import { ConfigModule } from './config/config.module';
import { FeedbackModule } from './feedback/feedback.module';
import { MetricsModule } from './metrics/metrics.module';
import { NotifyModule } from './notify/notify.module';
import { PolicyModule } from './policy/policy.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule, // @Global AppConfig
    PrismaModule, // @Global PrismaService
    RedisModule, // @Global RedisService
    MetricsModule, // @Global MetricsService
    NotifyModule, // @Global NotifyService
    PolicyModule, // policy engine + TCP server
    FeedbackModule, // bounce-rate ingest (option B)
    AdminModule, // REST API + UI
  ],
})
export class AppModule {}
