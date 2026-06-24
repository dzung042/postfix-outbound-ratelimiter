import { Global, Module } from '@nestjs/common';
import { AppConfig } from './app-config';

/** AppConfig is needed everywhere; expose it as a global singleton. */
@Global()
@Module({
  providers: [AppConfig],
  exports: [AppConfig],
})
export class ConfigModule {}
