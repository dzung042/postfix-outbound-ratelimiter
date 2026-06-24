import { Module } from '@nestjs/common';
import { PolicyModule } from '../policy/policy.module';
import { FeedbackController } from './feedback.controller';
import { FeedbackTokenGuard } from './feedback-token.guard';
import { FeedbackService } from './feedback.service';

@Module({
  imports: [PolicyModule], // AnomalyService, SenderControlService, EventWriterService
  controllers: [FeedbackController],
  providers: [FeedbackService, FeedbackTokenGuard],
  exports: [FeedbackService],
})
export class FeedbackModule {}
