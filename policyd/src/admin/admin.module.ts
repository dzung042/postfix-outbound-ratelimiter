import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfig } from '../config/app-config';
import { FeedbackModule } from '../feedback/feedback.module';
import { PolicyModule } from '../policy/policy.module';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { JwtAuthGuard } from './auth/jwt.guard';
import { DashboardController } from './dashboard.controller';
import { DomainsController } from './domains.controller';
import { EventsController } from './events.controller';
import { SendersController } from './senders.controller';
import { TiersController } from './tiers.controller';

@Module({
  imports: [
    PolicyModule,
    FeedbackModule,
    JwtModule.registerAsync({
      inject: [AppConfig],
      useFactory: (cfg: AppConfig) => ({
        secret: cfg.jwtSecret,
        signOptions: { expiresIn: cfg.jwtTtl },
      }),
    }),
  ],
  controllers: [
    AuthController,
    TiersController,
    DomainsController,
    SendersController,
    EventsController,
    DashboardController,
  ],
  providers: [AuthService, JwtAuthGuard],
})
export class AdminModule {}
