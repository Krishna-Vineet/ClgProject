/**
 * Time-range helpers. All ranges are half-open [start, end).
 * Adjacent bookings (end === next start) must NOT conflict.
 */

export type TimeRange = { startsAt: Date | string; endsAt: Date | string };

export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function isValidRange(range: TimeRange): boolean {
  const start = toDate(range.startsAt).getTime();
  const end = toDate(range.endsAt).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

/** Half-open overlap: [aStart,aEnd) ∩ [bStart,bEnd) ≠ ∅ */
export function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  const aStart = toDate(a.startsAt).getTime();
  const aEnd = toDate(a.endsAt).getTime();
  const bStart = toDate(b.startsAt).getTime();
  const bEnd = toDate(b.endsAt).getTime();
  return aStart < bEnd && bStart < aEnd;
}

/** True when `inner` lies completely inside `outer`. */
export function rangeContains(outer: TimeRange, inner: TimeRange): boolean {
  return (
    toDate(inner.startsAt).getTime() >= toDate(outer.startsAt).getTime() &&
    toDate(inner.endsAt).getTime() <= toDate(outer.endsAt).getTime()
  );
}

export function rangeDurationMinutes(range: TimeRange): number {
  return Math.round((toDate(range.endsAt).getTime() - toDate(range.startsAt).getTime()) / 60_000);
}

/** Merge overlapping/adjacent ranges into busy blocks. Input need not be sorted. */
export function mergeRanges(ranges: TimeRange[]): Array<{ startsAt: string; endsAt: string }> {
  const sorted = ranges
    .map((r) => ({ start: toDate(r.startsAt).getTime(), end: toDate(r.endsAt).getTime() }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged.map((m) => ({
    startsAt: new Date(m.start).toISOString(),
    endsAt: new Date(m.end).toISOString(),
  }));
}

/** Day buckets (UTC) covering a range, for calendar grids. */
export function eachDay(range: TimeRange, maxDays = 62): string[] {
  const start = toDate(range.startsAt);
  const end = toDate(range.endsAt);
  const days: string[] = [];
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  while (cursor.getTime() <= end.getTime() && days.length < maxDays) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}
