/**
 * The clock the whole app reads. Nothing else calls `new Date()` for "now", so
 * setting NOW (and TZ) makes every date question reproducible.
 */
export interface Clock {
  now(): Date;
  tz: string;
}

/** Offset (minutes east of UTC) of a time zone at a given instant. */
export function tzOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** Wall-clock fields in a zone -> the instant they refer to. */
export function zonedToInstant(
  tz: string,
  y: number,
  mo: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let offset = tzOffsetMinutes(tz, new Date(guess));
  let t = guess - offset * 60000;
  // a second pass handles instants near a DST change
  const offset2 = tzOffsetMinutes(tz, new Date(t));
  if (offset2 !== offset) t = guess - offset2 * 60000;
  return new Date(t);
}

/** Calendar fields of an instant as seen in a zone. */
export function zonedFields(tz: string, at: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: get('weekday'),
  };
}

/** Parse NOW: an ISO string with an offset, or wall-clock time in `tz`. */
export function parseNow(value: string, tz: string): Date {
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
  if (hasOffset) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new Error(`NOW is not a valid date: ${value}`);
    return d;
  }
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new Error(`NOW must look like 2026-11-13 or 2026-11-13T10:00:00 (got "${value}")`);
  return zonedToInstant(tz, +m[1], +m[2], +m[3], +(m[4] ?? 12), +(m[5] ?? 0), +(m[6] ?? 0));
}

/** Real clock, or one that starts at NOW and keeps ticking from there. */
export function makeClock(opts: { nowOverride?: string; tz: string }): Clock {
  if (!opts.nowOverride) return { now: () => new Date(), tz: opts.tz };
  const base = parseNow(opts.nowOverride, opts.tz).getTime();
  const started = Date.now();
  return { now: () => new Date(base + (Date.now() - started)), tz: opts.tz };
}

/** A clock that never moves: for tests and the eval. */
export function frozenClock(iso: string, tz: string): Clock {
  const fixed = parseNow(iso, tz);
  return { now: () => new Date(fixed.getTime()), tz };
}

export function formatInZone(at: Date, tz: string, withTime = true): string {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  };
  if (withTime) {
    opts.hour = '2-digit';
    opts.minute = '2-digit';
    opts.hourCycle = 'h23';
  }
  return new Intl.DateTimeFormat('en-GB', opts).format(at);
}

export function isoDay(at: Date, tz: string): string {
  const f = zonedFields(tz, at);
  return `${f.year}-${String(f.month).padStart(2, '0')}-${String(f.day).padStart(2, '0')}`;
}
