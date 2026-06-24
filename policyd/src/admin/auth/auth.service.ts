import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, timingSafeEqual } from 'crypto';
import { AppConfig } from '../../config/app-config';

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}
/** Length-independent constant-time string compare. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

@Injectable()
export class AuthService {
  constructor(
    private readonly cfg: AppConfig,
    private readonly jwt: JwtService,
  ) {}

  async login(username: string, password: string): Promise<{ token: string }> {
    const okUser = safeEqual(username || '', this.cfg.adminUser);
    const okPass = safeEqual(password || '', this.cfg.adminPassword);
    // Evaluate both before deciding to avoid leaking which field was wrong.
    if (!okUser || !okPass) throw new UnauthorizedException('Invalid credentials');
    const token = await this.jwt.signAsync({ sub: username, role: 'admin' });
    return { token };
  }
}
