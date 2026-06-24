/**
 * Minimal IPv4 CIDR allowlist. Behind HAProxy (TCP mode) the peer is the proxy,
 * so this is a coarse guard - set POLICY_ALLOW_CIDRS to the proxy/MTA subnet, or
 * leave it empty and rely on network isolation/firewall. Abuse attribution uses
 * the SMTP client_address attribute from the request, not the TCP peer.
 */
function ipv4ToInt(ip: string): number | null {
  const m = ip.split('.');
  if (m.length !== 4) return null;
  let n = 0;
  for (const part of m) {
    const o = Number(part);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

export function normalizeIp(ip: string): string {
  // Strip IPv4-mapped IPv6 prefix that Node reports (e.g. ::ffff:10.0.0.1).
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function ipAllowed(rawIp: string, cidrs: string[]): boolean {
  if (cidrs.length === 0) return true; // no allowlist configured -> allow all
  const ip = normalizeIp(rawIp);
  const ipInt = ipv4ToInt(ip);
  for (const rule of cidrs) {
    if (rule === ip) return true; // exact match (also covers IPv6 literals)
    if (ipInt === null) continue;
    const [net, bitsStr] = rule.split('/');
    const bits = bitsStr === undefined ? 32 : Number(bitsStr);
    const netInt = ipv4ToInt(net);
    if (netInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((ipInt & mask) === (netInt & mask)) return true;
  }
  return false;
}
