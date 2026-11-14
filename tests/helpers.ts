import type { LLM, StepRequest, StepResult } from '../src/llm.ts';
import type { TavilyLike, TavilyResult, TavilySearchParams } from '../src/search.ts';

/** A model that answers from a script, so tests need no network and no quota. */
export class ScriptedLLM implements LLM {
  requests: StepRequest[] = [];
  private i = 0;
  constructor(private script: Array<StepResult | ((req: StepRequest) => StepResult)>) {}

  async step(req: StepRequest, onText: (d: string) => void): Promise<StepResult> {
    this.requests.push(req);
    const item = this.script[Math.min(this.i++, this.script.length - 1)];
    const res = typeof item === 'function' ? item(req) : item;
    if (res.text) onText(res.text);
    return res;
  }
}

export const say = (text: string): StepResult => ({ text, calls: [] });

export const callSearch = (queries: string[], freshness?: string, id = 'call_1'): StepResult => ({
  text: '',
  calls: [{ id, name: 'web_search', args: { queries, ...(freshness ? { freshness } : {}) } }],
});

export const callSearches = (batches: string[][]): StepResult => ({
  text: '',
  calls: batches.map((q, i) => ({ id: `call_${i}`, name: 'web_search', args: { queries: q } })),
});

/** A search backend backed by a table of canned pages. */
export class FakeTavily implements TavilyLike {
  searches: TavilySearchParams[] = [];
  extracts: string[][] = [];
  constructor(
    private pages: Record<string, { title: string; url: string; content: string; raw?: string; published?: string }[]> = {},
    private opts: { failSearch?: boolean } = {},
  ) {}

  private find(query: string) {
    const q = query.toLowerCase();
    for (const [k, v] of Object.entries(this.pages)) if (q.includes(k.toLowerCase())) return v;
    return [];
  }

  async search(p: TavilySearchParams): Promise<TavilyResult[]> {
    this.searches.push(p);
    if (this.opts.failSearch) throw new Error('Tavily search returned 500');
    return this.find(p.query).map((r, i) => ({
      url: r.url,
      title: r.title,
      content: r.content,
      score: 1 - i * 0.1,
      published_date: p.topic === 'news' ? (r.published ?? null) : null,
    }));
  }

  async extract(urls: string[]) {
    this.extracts.push(urls);
    const all = Object.values(this.pages).flat();
    return urls.map((u) => ({ url: u, raw_content: all.find((r) => r.url === u)?.raw ?? '' })).filter((r) => r.raw_content);
  }
}
