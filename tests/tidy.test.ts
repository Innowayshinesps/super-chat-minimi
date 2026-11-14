import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tidyAnswer, tidyDelta } from '../src/tidy.ts';

test('odd spaces and zero-width characters become plain text', () => {
  assert.equal(tidyDelta('3 Nov 2026​'), '3 Nov 2026');
});

test('【label】(url) and 【label†url】 become markdown links', () => {
  assert.equal(tidyAnswer('Price is $25 【Supabase pricing】(https://supabase.com/pricing).'), 'Price is $25 [Supabase pricing](https://supabase.com/pricing).');
  assert.equal(tidyAnswer('Node 24 【Node.js Releases†https://nodejs.org/en/about/previous-releases】'), 'Node 24 [Node.js Releases](https://nodejs.org/en/about/previous-releases)');
});

test('a citation marker with no usable link is removed, not left as noise', () => {
  assert.equal(tidyAnswer('Still free【0†text】 for small projects.'), 'Still free for small projects.');
  assert.equal(tidyAnswer('Neon is cheapest (as of 3 Nov 2026) 【Unknown thing】.'), 'Neon is cheapest (as of 3 Nov 2026).');
});

test('mixed brackets 【label](url) become a link', () => {
  assert.equal(
    tidyAnswer('Node 26 is LTS【Node.js 26 LTS: How to Upgrade -](https://example.dev/guide).'),
    'Node 26 is LTS [Node.js 26 LTS: How to Upgrade -](https://example.dev/guide).',
  );
});

test('a marker that only names its source is matched to a page read this turn', () => {
  const sources = [
    { title: 'Pipedrive raises plan prices from 1 December', url: 'https://www.pipedrive.com/en/blog/pricing-update' },
    { title: 'Node.js Releases', url: 'https://nodejs.org/en/about/previous-releases' },
  ];
  assert.equal(
    tidyAnswer('Advanced is now $34【Pipedrive blog – pricing update (11 Nov 2026)】.', sources),
    'Advanced is now $34 [Raises plan prices from 1 December](https://www.pipedrive.com/en/blog/pricing-update).'.replace('Raises', 'Pipedrive raises'),
  );
  assert.match(tidyAnswer('Node 24 is LTS【Node.js Releases】', sources), /\[Node\.js Releases\]\(https:\/\/nodejs\.org\//);
  assert.equal(tidyAnswer('Something【Unrelated thing】.', sources), 'Something.');
});

test('a bare [label] is matched to its source, a Memory citation loses its brackets, real links are untouched', () => {
  const sources = [{ title: 'Pricing & Fees | Supabase', url: 'https://supabase.com/pricing' }];
  assert.equal(
    tidyAnswer('Free 500 MB [Pricing & Fees | Supabase]. As said before [Memory, 3 Nov 2026].', sources),
    'Free 500 MB [Pricing & Fees | Supabase](https://supabase.com/pricing). As said before (Memory, 3 Nov 2026).',
  );
  const ok = 'See [Supabase](https://supabase.com/pricing) and [1] and [sic].';
  assert.equal(tidyAnswer(ok, sources), ok);
});

test('every search result carries a ready-made link to copy', async () => {
  const { webSearch } = await import('../src/search.ts');
  const { frozenClock } = await import('../src/clock.ts');
  const { FakeTavily } = await import('./helpers.ts');
  const out = await webSearch(
    { queries: ['neon pricing'] },
    { tavily: new FakeTavily({ neon: [{ title: 'Neon [Pricing]', url: 'https://neon.com/pricing', content: 'x' }] }), clock: frozenClock('2026-11-13T10:00:00', 'UTC') },
  );
  assert.equal((out.response.results as Array<{ cite_as: string }>)[0].cite_as, '[Neon Pricing](https://neon.com/pricing)');
});

test('normal markdown is left alone', () => {
  const s = 'Neon is usage-based ([Neon pricing](https://neon.com/pricing)).\n\n| a | b |\n| - | - |';
  assert.equal(tidyAnswer(s), s);
});

test('a link glued to the word before it gets a space', () => {
  assert.equal(tidyAnswer('on 13 Nov 2026[Site](https://x.com/a).'), 'on 13 Nov 2026 [Site](https://x.com/a).');
  assert.equal(tidyAnswer('already [Site](https://x.com/a) fine'), 'already [Site](https://x.com/a) fine');
});

test('a bare URL becomes a titled link if it was read this turn, and is dropped if not', () => {
  const sources = [{ title: 'Jensen Huang: What we know', url: 'https://www.npr.org/a/b' }];
  assert.equal(
    tidyAnswer('She left https://www.bbc.com/news/x https://www.npr.org/a/b.', sources),
    'She left [Jensen Huang: What we know](https://www.npr.org/a/b).',
  );
  assert.equal(tidyAnswer('ok [x](https://a.com/p) done', []), 'ok [x](https://a.com/p) done');
});

test('no em or en dashes in replies', () => {
  assert.equal(tidyAnswer('Free tier — 500 MB, 10–20 users, well—known.'), 'Free tier, 500 MB, 10-20 users, well, known.');
  assert.equal(tidyDelta(' —') + tidyDelta(' here'), ', here');
});
