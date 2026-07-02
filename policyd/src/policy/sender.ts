/**
 * Normalize the SMTP principal used as the rate-limit key: trim + lowercase, and
 * strip a BATV tag so a tag that rotates per-day/per-key does not fragment the
 * sender's counter (each rotated tag would otherwise look like a new identity).
 *
 *   prvs=16418a1d08=user@dom  ->  user@dom
 *   btv1=abc123=user@dom      ->  user@dom
 *
 * BATV tags only ever appear as a prefix on the local-part; a plain address is
 * returned unchanged. Mirrors the strip in pmg-templates/outbound-spam-guard.sh.
 */
export function normalizeSender(raw: string): string {
  const s = (raw || '').trim().toLowerCase();
  return s.replace(/^(?:prvs|btv1)=[0-9a-z]+=/, '');
}
