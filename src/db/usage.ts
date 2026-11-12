import type { DatabaseSync } from "node:sqlite";

/**
 * 使用量の「1日」の区切りになる日付(YYYY-MM-DD)。
 * タイムゾーンは設定(usageTimeZone)で選べる。既定はUTC。
 */
export function usageDate(now: Date = new Date(), timeZone = "UTC"): string {
  // en-CA ロケールは YYYY-MM-DD 形式で出力される
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function getProviderUsageToday(
  db: DatabaseSync,
  provider: string,
  date = usageDate(),
): { requestCount: number; isExhausted: boolean } {
  const row = db
    .prepare(`SELECT request_count, is_exhausted FROM provider_usage WHERE provider = ? AND date = ?`)
    .get(provider, date) as { request_count: number; is_exhausted: number } | undefined;
  if (!row) return { requestCount: 0, isExhausted: false };
  return { requestCount: row.request_count, isExhausted: row.is_exhausted === 1 };
}

export function recordProviderRequest(db: DatabaseSync, provider: string, date = usageDate()): void {
  db.prepare(
    `INSERT INTO provider_usage (provider, date, request_count, is_exhausted)
     VALUES (?, ?, 1, 0)
     ON CONFLICT(provider, date) DO UPDATE SET request_count = request_count + 1`,
  ).run(provider, date);
}

export function markProviderExhausted(db: DatabaseSync, provider: string, date = usageDate()): void {
  db.prepare(
    `INSERT INTO provider_usage (provider, date, request_count, is_exhausted)
     VALUES (?, ?, 0, 1)
     ON CONFLICT(provider, date) DO UPDATE SET is_exhausted = 1`,
  ).run(provider, date);
}
