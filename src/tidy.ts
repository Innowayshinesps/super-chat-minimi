/**
 * Small, deterministic clean-up of model output. Some models write citations as
 * 【label】(url) or 【label†url】 and use non-breaking spaces; the page and the
 * saved answers should see plain Markdown and plain spaces.
 */

export interface KnownSource {
  title: string;
  url: string;
}

/** Safe to apply to every streamed fragment on its own. */
/** No em or en dashes in replies: ranges get a hyphen, a dash between words becomes a comma. Works on a streamed chunk. */
function plainDashes(s: string): string {
  return s
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1-$2')
    .replace(/([A-Za-z])[–—]([A-Za-z])/g, '$1, $2')
    .replace(/\s*[–—](\s*)/g, ',$1')
    .replace(/[‐‑‒]/g, '-');
}

export function tidyDelta(s: string): string {
  return plainDashes(s).replace(/[    ]/g, ' ').replace(/[​-‍⁠﻿]/g, '');
}

function hostName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').split('.')[0].toLowerCase();
  } catch {
    return '';
  }
}

/** A label like "Pipedrive blog (11 Nov)" -> the source from this turn that it most likely means. */
function resolve(label: string, sources: KnownSource[]): KnownSource | undefined {
  const l = label.toLowerCase();
  let best: KnownSource | undefined;
  let bestScore = 0;
  for (const s of sources) {
    let score = 0;
    const host = hostName(s.url);
    if (host.length > 2 && l.includes(host)) score += 2;
    for (const w of new Set(s.title.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 3))) if (l.includes(w)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return bestScore >= 2 ? best : undefined;
}

const mdLabel = (s: string) => s.replace(/[\[\]]/g, '').trim();

/** Apply to a whole answer. `sources` are the pages the model read this turn. */
export function tidyAnswer(s: string, sources: KnownSource[] = []): string {
  return tidyDelta(s)
    .replace(/【([^】†]+?)†(https?:\/\/[^】\s]+)】/g, (_m, label: string, url: string) => `[${mdLabel(label)}](${url})`) // 【label†url】
    .replace(/【([^】]+)】\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => `[${mdLabel(label)}](${url})`) // 【label】(url)
    .replace(/【([^】\[\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => `[${mdLabel(label)}](${url})`) // 【label](url), mixed brackets
    .replace(/【([^】]*)】/g, (_m, label: string) => {
      // a marker with no link: use the source it names, if there is one; otherwise drop it
      const found = resolve(label.replace(/^\d+†/, ''), sources);
      return found ? `[${mdLabel(found.title).slice(0, 60)}](${found.url})` : '\u0000';
    })
    // [label] with no link: the source it names, or (Memory, 3 Nov) for a citation of the earlier chat
    .replace(/\[([^\[\]\n]{3,120})\](?![(:\[])/g, (m, label: string) => {
      const found = resolve(label, sources);
      if (found) return `[${mdLabel(label)}](${found.url})`;
      if (/^memory\b/i.test(label.trim())) return `(${label.trim()})`;
      return m;
    })
    // a bare URL: the titled link if this turn read that page, otherwise dropped (it was not read, so it is not a citation)
    .replace(/(?<![\]("<\w])https?:\/\/[^\s)\]>"]+/g, (m) => {
      const url = m.replace(/[.,;:!?]+$/, '');
      const tail = m.slice(url.length);
      const found = sources.find((s) => s.url.replace(/\/$/, '') === url.replace(/\/$/, ''));
      return found ? `[${mdLabel(found.title).slice(0, 60)}](${found.url})${tail}` : '\u0000' + tail;
    })
    .replace(/([A-Za-z0-9%)])(\[[^\]\n]+\]\(https?:\/\/)/g, '$1 $2') // a link glued to the word before it
    .replace(/ *\u0000/g, '') // a dropped marker takes the space before it with it
    .replace(/[ \t]+\n/g, '\n')
    .replace(/ {2,}/g, ' ');
}
