/**
 * Fixed-window bucket math, aligned to wall-clock (local TZ via the TZ env var).
 * Aligning to the clock means "per day" resets at local midnight, "per hour" on
 * the hour, etc. - intuitive for operators and for the admin UI.
 */
export type WindowName = 'm1' | 'h1' | 'd1' | 'mo';

export interface Bucket {
  window: WindowName;
  id: string; // wall-clock bucket id, e.g. 2026062116 for the 16:00 hour
  ttl: number; // seconds until this bucket ends (+ grace)
}

const p2 = (n: number) => String(n).padStart(2, '0');

export function buckets(now: Date): Record<WindowName, Bucket> {
  const Y = now.getFullYear();
  const Mo = p2(now.getMonth() + 1);
  const D = p2(now.getDate());
  const H = p2(now.getHours());
  const Mi = p2(now.getMinutes());
  const sec = now.getSeconds();

  const secToNextMinute = 60 - sec;
  const secToNextHour = (60 - now.getMinutes()) * 60 - sec;
  const endOfDay = new Date(Y, now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const secToNextDay = Math.ceil((endOfDay.getTime() - now.getTime()) / 1000);
  const endOfMonth = new Date(Y, now.getMonth() + 1, 1, 0, 0, 0, 0);
  const secToNextMonth = Math.ceil((endOfMonth.getTime() - now.getTime()) / 1000);

  return {
    m1: { window: 'm1', id: `${Y}${Mo}${D}${H}${Mi}`, ttl: secToNextMinute + 5 },
    h1: { window: 'h1', id: `${Y}${Mo}${D}${H}`, ttl: secToNextHour + 30 },
    d1: { window: 'd1', id: `${Y}${Mo}${D}`, ttl: secToNextDay + 60 },
    mo: { window: 'mo', id: `${Y}${Mo}`, ttl: secToNextMonth + 300 },
  };
}

export function counterKey(scope: 'email' | 'domain', id: string, b: Bucket): string {
  return `${scope}:${id}:${b.window}:${b.id}`;
}
