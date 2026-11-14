# Minimi chat agent

A chat agent with one tool, web search. It answers fast, rechecks anything that may have changed, and remembers what it read earlier, so "has anything changed since Monday?" compares today's search with what it actually saw then.

How it works and why is in [DESIGN.md](DESIGN.md).

## Run it

Needs Node 22.13 or newer (it uses Node's built-in SQLite, so there is nothing native to build).

```sh
npm install
cp .env.example .env     # then fill in the keys
npm run dev              # http://localhost:3000
```

Keys (all in `.env`):

| Key | Needed for |
| --- | --- |
| `GROQ_API_KEY` | the agent (`npm run dev`) |
| `TAVILY_API_KEY` | web search (`npm run dev`) |
| `GEMINI_API_KEY` | optional: the backup model, and the eval judge (`npm run eval`) |

The agent is `openai/gpt-oss-120b` on Groq by default (`AGENT_PROVIDER`, `AGENT_MODEL`, `AGENT_EFFORT` in `.env`). On start it checks that your key can see the model and says so if not. Groq's free tier allows about 200,000 tokens a day and 8,000 a minute for this model. A turn that searches uses roughly 5 to 9 thousand tokens, so that is a few dozen searching turns a day. If the day's limit is used up and `GEMINI_API_KEY` is set, the turn carries on with `FALLBACK_MODEL` (the page says so); without it you get a clear quota message. A short per-minute wait (two searching questions in a row) is waited out; a longer wait or a request over the per-minute cap also moves that turn to the backup, and the page says why. These workarounds exist only for free keys, and on Groq's paid tier none of this applies.

## Try the memory

`npm run dev` starts with an empty history, stored in `data/` on your machine (the repo ships no database). To try the memory features right away, add two older chats first:

```sh
npm run seed      # optional: Postgres hosting on Tue 3 Nov 2026, a five-tool CRM shortlist on Mon 9 Nov 2026
npm run dev
```

The research in those chats is made up and says so. Try:

- `What did I ask you on 3 November? Is your answer still correct today?`
- `Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?`
- `On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?`
- `What did I ask you on 5 November?` (nothing was asked that day, so it should say so)

`npm run seed` does nothing if the database already has chats. For a throwaway copy that also freezes the clock at Friday 13 Nov 2026, so the dates above match exactly, use `npm run dev:demo` (its own database, `data/demo.db`).

Under each answer, **What I used** shows which dates were resolved, which earlier turns were recalled, and every search with its sources.

To use your own clock, set `NOW` (for example `NOW=2026-11-13T10:00:00`) and `TZ` (for example `TZ=Asia/Kolkata`) in `.env`. Every date question reads that clock.

## Test it

```sh
npm test         # 50 tests, no network and no API quota
npm run eval     # end to end on the real model with recorded web pages; writes evals/RESULTS.md
npm run typecheck
```

`npm run eval -- crm abstain` runs only the cases whose names contain those words; `--no-judge` skips the Groq judge.

## Layout

```
src/
  server.ts    HTTP + server-sent events
  chat.ts      one turn: context -> agent -> save
  context.ts   the context engine (code, no model call)
  dates.ts     "last Tuesday" -> an exact date range, against the injected clock
  agent.ts     the one agent loop
  search.ts    the one tool: web_search (Tavily search + page reading)
  llm.ts       the model boundary: neutral messages, shared retry rules
  groq.ts      the Groq adapter (default); gemini.ts is the same boundary for Gemini
  tidy.ts      small clean-up of model output (citation brackets, odd spaces)
  models.ts    picks the agent's model from .env
  db.ts        append-only SQLite
  prompt.ts    the agent's policy
  seed.ts      demo history
web/           the page (plain HTML, CSS and one script)
tests/ evals/
```
