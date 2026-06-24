import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { AppConfig } from '../config/app-config';

function eq(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/**
 * Guards the delivery-feedback ingest endpoint with a shared secret
 * (X-Feedback-Token), separate from the admin JWT so the log shipper does not
 * need an interactive login. If FEEDBACK_TOKEN is unset, the endpoint is closed.
 */
@Injectable()
export class FeedbackTokenGuard implements CanActivate {
  constructor(private readonly cfg: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (!this.cfg.feedbackToken) {
      throw new ServiceUnavailableException('Feedback ingest disabled (set FEEDBACK_TOKEN)');
    }
    const req = ctx.switchToHttp().getRequest<Request>();
    const tok = (req.headers['x-feedback-token'] as string) || '';
    if (!tok || !eq(tok, this.cfg.feedbackToken)) {
      throw new UnauthorizedException('Invalid feedback token');
    }
    return true;
  }
}
