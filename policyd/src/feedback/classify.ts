export type Outcome = 'ok' | 'bounce' | 'spam' | 'defer';

/**
 * Classify a delivery outcome from MTA log fields. `spam` (remote flagged
 * spam/blocked/blacklist) is the strongest abuse signal and weighed highest;
 * `bounce` = hard 5.x.x; `defer` = soft 4.x.x; everything else = ok.
 */
export function classify(status?: string, dsn?: string, text?: string): Outcome {
  const d = (dsn || '').trim();
  const blob = `${status || ''} ${d} ${text || ''}`.toLowerCase();

  if (/\b(spam|blocked|blacklist|barracuda|blocklist|reputation|denied|rejected for policy|5\.7\.)/.test(blob)) {
    return 'spam';
  }
  if (d.startsWith('5.') || /\bbounced\b/.test(blob)) return 'bounce';
  if (d.startsWith('4.') || /\bdeferred\b|\bdeferral\b|\btry again\b/.test(blob)) return 'defer';
  if (d.startsWith('2.') || /\bsent\b|\bdelivered\b/.test(blob)) return 'ok';
  return 'ok';
}
