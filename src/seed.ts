import { fileURLToPath } from 'node:url';
import { zonedToInstant } from './clock.ts';
import type { NewEvidence, NewTurn } from './db.ts';
import { Store, titleFrom } from './db.ts';

/**
 * Demo history, so "last Tuesday" can be tried without waiting a week.
 * Dated for a clock set to Friday 13 November 2026 (see `npm run dev:demo`):
 *
 *   Tue  3 Nov 2026  Postgres hosting: Supabase, Neon, Railway
 *   Mon  9 Nov 2026  CRM shortlist: five tools for a 20-person sales team
 *
 * The research in these chats is synthetic. Each answer says so, and the chat
 * titles start with "Demo", so nobody mistakes the old prices for real ones.
 */

export const DEMO_NOW = '2026-11-13T10:00:00';

const NOTE = '\n\n_Seeded demo history, not real research._';

interface DemoTurn {
  day: [number, number, number];
  time: [number, number];
  question: string;
  answer: string;
  queries: Array<{ query: string; evidence: NewEvidence[] }>;
}

const ev = (url: string, title: string, text: string, published: string | null = null): NewEvidence => ({
  url,
  title,
  published_date: published,
  content_excerpt: text,
});

const DEMO: Array<{ title: string; turns: DemoTurn[] }> = [
  {
    title: 'Demo: Postgres hosting for a side project',
    turns: [
      {
        day: [2026, 11, 3],
        time: [14, 5],
        question: 'Which managed Postgres host is cheapest for a small side project? Compare Supabase, Neon and Railway.',
        queries: [
          {
            query: 'Supabase pricing Pro plan',
            evidence: [
              ev(
                'https://supabase.com/pricing',
                'Pricing & Fees | Supabase',
                'Free: 500 MB database, 5 GB egress, projects pause after a week of inactivity. Pro: $25/month per organization, 8 GB database and 250 GB egress included, no pausing, daily backups. Overage: $0.125/GB database.',
              ),
            ],
          },
          {
            query: 'Neon Postgres pricing plans',
            evidence: [
              ev(
                'https://neon.com/pricing',
                'Neon Pricing',
                'Free: 0.5 GB storage per project, 191 compute hours a month. Launch: usage-based, $0.106 per compute-hour and $0.35 per GB-month of storage, no monthly minimum. Scale: usage-based with higher limits.',
              ),
            ],
          },
          {
            query: 'Railway Postgres pricing Hobby plan',
            evidence: [
              ev(
                'https://railway.com/pricing',
                'Railway Pricing',
                'Hobby: $5/month including $5 of usage, then pay for what you use. Pro: $20/month per seat. Postgres runs as a normal service, billed by CPU, memory and storage.',
              ),
            ],
          },
        ],
        answer:
          '**Neon is cheapest for a small project that is idle most of the time**; Supabase is the simplest all-in-one at a flat price.\n\n' +
          '| Host | Plan | Price | Notes |\n| --- | --- | --- | --- |\n' +
          '| Supabase | Pro | $25/month ([source](https://supabase.com/pricing)) | 8 GB database, no pausing, backups |\n' +
          '| Neon | Launch | usage-based, no minimum ([source](https://neon.com/pricing)) | $0.106 per compute-hour, $0.35 per GB-month |\n' +
          '| Railway | Hobby | $5/month plus usage ([source](https://railway.com/pricing)) | Postgres is a regular service |\n\n' +
          '(as of 3 Nov 2026)' +
          NOTE,
      },
    ],
  },
  {
    title: 'Demo: CRM shortlist for a 20-person sales team',
    turns: [
      {
        day: [2026, 11, 9],
        time: [11, 30],
        question: 'Shortlist 5 CRM tools for a 20-person sales team and compare their pricing.',
        queries: [
          {
            query: 'best CRM for small sales teams 2026 pricing comparison',
            evidence: [
              ev(
                'https://www.hubspot.com/pricing/sales',
                'HubSpot Sales Hub pricing',
                'Sales Hub Starter: $20 per seat per month, billed annually. Professional: $100 per seat per month.',
              ),
              ev(
                'https://www.pipedrive.com/en/pricing',
                'Pipedrive pricing',
                'Essential: $14 per seat per month. Advanced: $29 per seat per month. Professional: $49 per seat per month, billed annually.',
              ),
              ev(
                'https://www.zoho.com/crm/zohocrm-pricing.html',
                'Zoho CRM pricing',
                'Standard: $14 per user per month. Professional: $23 per user per month. Enterprise: $40 per user per month, billed annually.',
              ),
              ev(
                'https://www.salesforce.com/sales/pricing/',
                'Salesforce Sales pricing',
                'Starter Suite: $25 per user per month. Pro Suite: $100 per user per month, billed annually.',
              ),
              ev(
                'https://www.freshworks.com/crm/pricing/',
                'Freshsales pricing',
                'Growth: $9 per user per month. Pro: $39 per user per month. Enterprise: $59 per user per month, billed annually.',
              ),
            ],
          },
        ],
        answer:
          'Shortlist for a 20-person sales team, with per-seat monthly prices (annual billing):\n\n' +
          '1. **HubSpot Sales Hub Starter**: $20 ([source](https://www.hubspot.com/pricing/sales))\n' +
          '2. **Pipedrive Advanced**: $29 ([source](https://www.pipedrive.com/en/pricing))\n' +
          '3. **Zoho CRM Standard**: $14 ([source](https://www.zoho.com/crm/zohocrm-pricing.html))\n' +
          '4. **Salesforce Starter Suite**: $25 ([source](https://www.salesforce.com/sales/pricing/))\n' +
          '5. **Freshsales Growth**: $9 ([source](https://www.freshworks.com/crm/pricing/))\n\n' +
          'For 20 seats that is roughly $180 to $580 a month. (as of 9 Nov 2026)' +
          NOTE,
      },
    ],
  },
];

/** Write the demo chats into an empty store. Returns how many chats were added. */
export function seedDemo(store: Store, tz: string): number {
  let added = 0;
  for (const chat of DEMO) {
    const first = chat.turns[0];
    const at = (t: DemoTurn, addMinutes = 0) =>
      new Date(zonedToInstant(tz, t.day[0], t.day[1], t.day[2], t.time[0], t.time[1]).getTime() + addMinutes * 60000);
    const created = store.createChat(chat.title, at(first));
    for (const t of chat.turns) {
      const retrieved = at(t, 1);
      const turn: NewTurn = {
        chatId: created.id,
        userText: t.question,
        assistantText: t.answer,
        userAt: at(t),
        assistantAt: at(t, 2),
        ttftMs: 1800,
        totalMs: 9000,
        searches: t.queries.map((q) => ({ query: q.query, retrievedAt: retrieved, evidence: q.evidence })),
      };
      store.saveTurn(turn);
    }
    added++;
  }
  return added;
}

// `npm run seed` writes the demo chats into the normal database.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { config } = await import('./config.ts');
  const store = new Store(config.dbPath);
  if (store.messageCount() > 0) {
    console.log(`The database at ${config.dbPath} already has chats, so nothing was added.`);
    console.log('Try the demo instead: npm run dev:demo (it uses its own database).');
  } else {
    const n = seedDemo(store, config.tz);
    console.log(`Added ${n} demo chats, dated 3 and 9 November 2026.`);
    console.log('Now run: npm run dev   (for the exact dates in the README, use npm run dev:demo instead).');
  }
  store.close();
}

export { titleFrom };
