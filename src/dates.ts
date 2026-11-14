import * as chrono from 'chrono-node';
import { type Clock, formatInZone, tzOffsetMinutes, zonedFields, zonedToInstant } from './clock.ts';

/**
 * Turns date phrases in a message ("last Tuesday", "3 November", "yesterday",
 * "the past 3 days") into exact time ranges, using the injected clock.
 * No model involved: the same input and clock always give the same ranges.
 */

export interface Range {
  label: string;
  start: Date; // inclusive
  end: Date; // exclusive
}

export interface DateRef extends Range {
  phrase: string;
  /** "last Tuesday" can mean two different days; the other reading goes here. */
  alt?: Range;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WD = WEEKDAYS.join('|');

type Ymd = { y: number; m: number; d: number };

function addDays(a: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(a.y, a.m - 1, a.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function cmp(a: Ymd, b: Ymd): number {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}

function dayRange(tz: string, from: Ymd, to: Ymd = from): Range {
  const start = zonedToInstant(tz, from.y, from.m, from.d);
  const next = addDays(to, 1);
  const end = zonedToInstant(tz, next.y, next.m, next.d);
  const sameDay = cmp(from, to) === 0;
  const last = new Date(end.getTime() - 1);
  const label = sameDay
    ? formatInZone(start, tz, false)
    : `${formatInZone(start, tz, false)} to ${formatInZone(last, tz, false)}`;
  return { label, start, end };
}

const PAST_CUE = /\b(did|was|were|had|asked|said|told|talked|discussed|researched|looked|ago|ever|before|earlier)\b/i;

export function resolveDates(text: string, clock: Clock): DateRef[] {
  const tz = clock.tz;
  const now = clock.now();
  const f = zonedFields(tz, now);
  const today: Ymd = { y: f.year, m: f.month, d: f.day };
  const todayWd = WEEKDAYS.indexOf(f.weekday.toLowerCase());
  const out: DateRef[] = [];
  let rest = text;

  const take = (re: RegExp, fn: (m: RegExpMatchArray) => Omit<DateRef, 'phrase'> | null) => {
    rest = rest.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), (...args) => {
      const groups = args.slice(0, -2) as string[];
      const m = Object.assign(groups, { index: args[args.length - 2] as number }) as unknown as RegExpMatchArray;
      const r = fn(m);
      if (r) out.push({ phrase: groups[0], ...r });
      return r ? ' '.repeat(groups[0].length) : groups[0];
    });
  };

  // the most recent given weekday strictly before today
  const lastWeekday = (wd: number): Ymd => {
    let diff = (todayWd - wd + 7) % 7;
    if (diff === 0) diff = 7;
    return addDays(today, -diff);
  };

  // "last Tuesday": most recent past Tuesday; the one a week earlier is the other reading
  take(new RegExp(`\\b(?:last|previous|this past)\\s+(${WD})\\b`, 'i'), (m) => {
    const day = lastWeekday(WEEKDAYS.indexOf(m[1].toLowerCase()));
    return { ...dayRange(tz, day), alt: dayRange(tz, addDays(day, -7)) };
  });

  // "on Monday" / "Monday": the most recent past Monday
  take(new RegExp(`\\b(?:on\\s+)?(?<!next\\s)(${WD})\\b`, 'i'), (m) => {
    return dayRange(tz, lastWeekday(WEEKDAYS.indexOf(m[1].toLowerCase())));
  });

  take(/\bday before yesterday\b/i, () => dayRange(tz, addDays(today, -2)));
  take(/\byesterday\b/i, () => dayRange(tz, addDays(today, -1)));
  if (PAST_CUE.test(text)) take(/\btoday\b|\bthis morning\b|\btonight\b/i, () => dayRange(tz, today));

  take(/\b(?:the\s+)?(?:past|last)\s+(\d{1,3}|a|one|two|three|four|five|six|seven)\s+(day|week)s?\b/i, (m) => {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    const n = (/\d/.test(m[1]) ? Number(m[1]) : words[m[1].toLowerCase()]) * (m[2].toLowerCase() === 'week' ? 7 : 1);
    return dayRange(tz, addDays(today, -n), today);
  });

  take(/\blast week\b/i, () => {
    // the previous Monday-to-Sunday week
    const sinceMonday = (todayWd + 6) % 7;
    const thisMonday = addDays(today, -sinceMonday);
    const lastMonday = addDays(thisMonday, -7);
    return { ...dayRange(tz, lastMonday, addDays(lastMonday, 6)), alt: dayRange(tz, addDays(today, -7), today) };
  });

  take(/\bthis week\b/i, () => {
    const sinceMonday = (todayWd + 6) % 7;
    return dayRange(tz, addDays(today, -sinceMonday), today);
  });

  // everything else: explicit dates ("3 November", "Nov 3", "2026-11-03", "3 days ago")
  const ref = { instant: now, timezone: tzOffsetMinutes(tz, now) };
  for (const r of chrono.parse(rest, ref, { forwardDate: false })) {
    const t = r.text.trim();
    // "may", "sat", "march" on their own are almost always ordinary words
    if (t.length <= 4 && !/\d/.test(t)) continue;
    if (/^(now|then|second|seconds|minute|minutes|hour|hours)$/i.test(t)) continue;
    if (/^(today|tonight|this morning)$/i.test(t.trim()) && !PAST_CUE.test(text)) continue; // "still correct today?" is about now
    const start = r.start;
    if (!start.isCertain('day') && !start.isCertain('weekday') && !/ago|last|past|yesterday/i.test(t)) continue;
    let y = start.get('year')!;
    const mo = start.get('month')!;
    const d = start.get('day')!;
    let from: Ymd = { y, m: mo, d };
    // "3 November" with no year, asked about in the past tense before 3 November, means last year's.
    // Without a past cue ("what's my work on 14 November?") a later date is just the future.
    // Words that point forward ("next", "tomorrow", "in 3 days") are not dates in history.
    const pointsForward = /\b(next|tomorrow|upcoming|in\s+\d+|coming)\b/i.test(t);
    if (cmp(from, today) > 0 && start.isCertain('month') && !start.isCertain('year') && !pointsForward && PAST_CUE.test(text)) {
      from = { y: y - 1, m: mo, d };
    }
    if (cmp(from, today) > 0) continue; // the future has no history
    let to = from;
    if (r.end) {
      to = { y: r.end.get('year')!, m: r.end.get('month')!, d: r.end.get('day')! };
      if (cmp(to, from) < 0) to = from;
      if (cmp(to, today) > 0) to = today;
    }
    out.push({ phrase: t, ...dayRange(tz, from, to) });
  }

  // keep order of appearance in the original text
  return out.sort((a, b) => text.indexOf(a.phrase) - text.indexOf(b.phrase));
}
