import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsArray, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { FeedbackService } from './feedback.service';
import { FeedbackTokenGuard } from './feedback-token.guard';

class DeliveryEventDto {
  @IsOptional() @IsString() @MaxLength(255) email?: string;
  @IsOptional() @IsString() @MaxLength(255) sender?: string;
  @IsOptional() @IsString() @MaxLength(64) status?: string;
  @IsOptional() @IsString() @MaxLength(32) dsn?: string;
  @IsOptional() @IsString() @MaxLength(512) text?: string;
  @IsOptional() @IsString() @MaxLength(32) queueId?: string;
  @IsOptional() @IsString() @MaxLength(45) clientIp?: string;
}

class DeliveryBatchDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => DeliveryEventDto)
  events!: DeliveryEventDto[];
}

@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  /** MTA log shipper POSTs delivery outcomes here. Auth via X-Feedback-Token. */
  @UseGuards(FeedbackTokenGuard)
  @Post('delivery')
  ingest(@Body() body: DeliveryBatchDto) {
    return this.feedback.ingest(body.events || []);
  }
}
