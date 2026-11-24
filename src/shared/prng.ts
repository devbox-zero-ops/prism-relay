/**
 * Deterministic PRNG (Mulberry32) and UTC calendar helpers.
 * Guarantees every Reddit player worldwide receives the exact same optical bench on a given UTC date.
 */

export function hashStringToSeed(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: () => number, minInclusive: number, maxExclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxExclusive - minInclusive));
}

export function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidUtcDateString(dateStr: string): boolean {
  if (!DATE_RE.test(dateStr)) return false;
  const parsed = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === dateStr;
}

export function getTodayUtcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addUtcDays(dateStr: string, deltaDays: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/** Days elapsed since launch epoch (2026-11-01 = Relay #1) */
export function getPuzzleNumberForDate(dateStr: string): number {
  const epochMs = Date.UTC(2026, 10, 1); // 2026-11-01
  const currentMs = Date.parse(`${dateStr}T00:00:00.000Z`);
  const diffDays = Math.floor((currentMs - epochMs) / 86400000);
  return Math.max(1, diffDays + 1);
}

/** Returns today and the previous 13 UTC dates (14 days total, newest first). */
export function getArchiveDates(todayUtc: string, count = 14): string[] {
  const dates: string[] = [];
  for (let i = 0; i < count; i++) {
    dates.push(addUtcDays(todayUtc, -i));
  }
  return dates;
}
