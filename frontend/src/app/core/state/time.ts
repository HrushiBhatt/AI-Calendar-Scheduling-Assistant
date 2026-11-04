const pad = (n: number) => String(n).padStart(2, '0');

/** 1499.2 → "25:00". Rounds up so the clock reads 00:00 only when time is truly up. */
export function formatClock(seconds: number): string {
  const s = Math.ceil(seconds);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/** 135 → "2h 15m" */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return h ? `${h}h ${minutes % 60}m` : `${minutes}m`;
}

/** The user's local calendar day as YYYY-MM-DD (not UTC). */
export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
