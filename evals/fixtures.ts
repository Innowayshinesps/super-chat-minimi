import { FakeTavily } from '../tests/helpers.ts';

/**
 * Recorded "web" for the eval. Search is replaced by these pages so a case
 * always sees the same world: one CRM tool raised its price, the rest did not,
 * and the Postgres hosts are unchanged.
 */

const page = (title: string, url: string, content: string, published?: string) => ({
  title,
  url,
  content,
  raw: `# ${title}\n\n${content}\n\n${'Other plan details and feature lists. '.repeat(40)}`,
  published,
});

export const WORLD = {
  hubspot: [
    page('HubSpot Sales Hub pricing', 'https://www.hubspot.com/pricing/sales', 'Sales Hub Starter: $20 per seat per month, billed annually. Professional: $100 per seat per month.'),
  ],
  pipedrive: [
    page('Pipedrive pricing', 'https://www.pipedrive.com/en/pricing', 'Essential: $19 per seat per month. Advanced: $34 per seat per month. Professional: $54 per seat per month, billed annually.'),
    page(
      'Pipedrive raises plan prices from 1 December',
      'https://www.pipedrive.com/en/blog/pricing-update',
      'Pipedrive announced on 11 November 2026 that the Advanced plan rises from $29 to $34 per seat per month, effective 1 December 2026.',
      '2026-11-11T09:00:00Z',
    ),
  ],
  zoho: [page('Zoho CRM pricing', 'https://www.zoho.com/crm/zohocrm-pricing.html', 'Standard: $14 per user per month. Professional: $23 per user per month. Enterprise: $40 per user per month, billed annually.')],
  salesforce: [page('Salesforce Sales pricing', 'https://www.salesforce.com/sales/pricing/', 'Starter Suite: $25 per user per month. Pro Suite: $100 per user per month, billed annually.')],
  freshsales: [page('Freshsales pricing', 'https://www.freshworks.com/crm/pricing/', 'Growth: $9 per user per month. Pro: $39 per user per month. Enterprise: $59 per user per month, billed annually.')],
  supabase: [page('Pricing & Fees | Supabase', 'https://supabase.com/pricing', 'Free: 500 MB database. Pro: $25/month per organization, 8 GB database and 250 GB egress included, no pausing.')],
  neon: [page('Neon Pricing', 'https://neon.com/pricing', 'Free: 0.5 GB storage per project. Launch: usage-based, $0.106 per compute-hour and $0.35 per GB-month, no monthly minimum.')],
  railway: [page('Railway Pricing', 'https://railway.com/pricing', 'Hobby: $5/month including $5 of usage. Pro: $20/month per seat.')],
  node: [
    page('Node.js Releases', 'https://nodejs.org/en/about/previous-releases', 'Node.js 24 is the current LTS (Active LTS). Node.js 25 is the Current release line. Last updated 2026-11-04.', '2026-11-04T00:00:00Z'),
  ],
};

export const freshWorld = () => new FakeTavily(WORLD);
