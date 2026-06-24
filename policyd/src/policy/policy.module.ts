import { Module } from '@nestjs/common';
import { AnomalyService } from './anomaly.service';
import { ConfigCacheService } from './config-cache.service';
import { EventWriterService } from './event-writer.service';
import { PolicyTcpServer } from './policy-tcp.server';
import { PolicyService } from './policy.service';
import { RateLimitService } from './ratelimit.service';
import { SenderControlService } from './sender-control.service';

@Module({
  providers: [
    ConfigCacheService,
    RateLimitService,
    AnomalyService,
    SenderControlService,
    EventWriterService,
    PolicyService,
    PolicyTcpServer,
  ],
  exports: [
    PolicyService,
    PolicyTcpServer,
    ConfigCacheService,
    SenderControlService,
    EventWriterService,
    AnomalyService,
  ],
})
export class PolicyModule {}
