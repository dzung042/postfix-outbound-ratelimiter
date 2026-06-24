import { Injectable, Logger } from '@nestjs/common';
import * as net from 'net';
import { AppConfig } from '../config/app-config';
import { ipAllowed, normalizeIp } from './ip';
import { PolicyRequest, PolicyService } from './policy.service';

const MAX_REQUEST_BYTES = 64 * 1024; // guard against unbounded buffering
const IDLE_TIMEOUT_MS = 60_000;

/**
 * Implements the Postfix policy delegation protocol (see SMTPD_POLICY_README).
 * A request is a series of `key=value\n` lines terminated by a blank line; the
 * reply is `action=VALUE\n\n`. Connections are reused for many requests.
 */
@Injectable()
export class PolicyTcpServer {
  private readonly log = new Logger('PolicyTCP');
  private server?: net.Server;

  constructor(
    private readonly cfg: AppConfig,
    private readonly policy: PolicyService,
  ) {}

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.onConnection(socket));
      this.server.on('error', reject);
      this.server.listen(this.cfg.policyPort, this.cfg.policyBind, () => {
        this.log.log(`policy protocol on ${this.cfg.policyBind}:${this.cfg.policyPort}`);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((res) => (this.server ? this.server.close(() => res()) : res()));
  }

  private onConnection(socket: net.Socket): void {
    const peer = normalizeIp(socket.remoteAddress || '');
    if (!ipAllowed(peer, this.cfg.allowCidrs)) {
      this.log.warn(`rejected connection from ${peer} (not in allowlist)`);
      socket.destroy();
      return;
    }
    socket.setTimeout(IDLE_TIMEOUT_MS);
    socket.setEncoding('utf8');

    let buf = '';
    let attrs: PolicyRequest = {};
    let total = 0;

    const reset = () => {
      attrs = {};
    };

    socket.on('data', (chunk: string) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);

        if (line === '') {
          // End of one request: decide and reply.
          const current = attrs;
          reset();
          total = 0;
          this.policy
            .decide(current)
            .then((action) => {
              if (!socket.destroyed) socket.write(`action=${action}\n\n`);
            })
            .catch(() => {
              if (!socket.destroyed) socket.write(`action=${this.cfg.failAction}\n\n`);
            });
        } else {
          const eq = line.indexOf('=');
          if (eq > 0) {
            const key = line.slice(0, eq);
            const val = line.slice(eq + 1);
            (attrs as Record<string, string>)[key] = val;
          }
        }
      }
    });

    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => socket.destroy());
  }
}
