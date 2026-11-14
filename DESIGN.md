# DESIGN

A chat agent with one tool, web search. It answers fast, rechecks anything that may have changed, and remembers what it read earlier, so "has anything changed since Monday?" compares today's search with the sources it actually saw then.

## How it works

Every message goes through four stages. Only stage 2 calls a model.

```
 user message
      │
 1. CONTEXT ENGINE  (plain code, no model call)
      │   resolves dates → looks up past turns → builds the "Memory" text
      ▼
 2. AGENT LOOP  (one model, one tool: web_search)
      │   reads Memory + chat → searches if needed → reads results → answers
      ▼
 3. CLEANUP  (code)  citations and formatting fixed
      ▼
 4. STORE  (SQLite, append-only)  question, searches, sources read, answer
```

**1. Context engine.** An injectable clock (`NOW`, `TZ`) and a date resolver turn "last Tuesday" or "3 November" into exact day ranges ("last Tuesday" has two readings, so both are kept and the model is told which was used). It then loads this chat, a one-line index of other chats, the turns from any resolved date, and turns sharing distinctive words with the message (SQLite full-text search). A recalled turn comes back whole: question, searches, sources read with their text and dates, answer. If a date has no record, the Memory says so and names the nearest recorded days, so the model says "no record" instead of inventing one. Over budget, it trims from the bottom of a fixed priority: current message, recent turns, exact past turns, their evidence, related turns, chat index.

**2. Agent loop.** One model (gpt-oss-120b on Groq) gets a short policy prompt, the Memory and one tool. `web_search` takes up to twelve queries, runs them in parallel on Tavily, adds a recent-news search when freshness matters, and reads the best pages in full with Tavily Extract (inside the tool, so the model sees one tool). Results are capped, about 8.5k characters per call and 10k per turn, so a turn stays fast. The loop ends as soon as the model answers without searching; after three rounds it is told to answer with what it has.

**3. Cleanup.** Citations are matched against the sources actually read; unread or broken links are dropped and odd characters and dashes are normalised.

**4. Store.** One SQLite file (`node:sqlite`, nothing native to build), append-only: `chats`, `messages`, `search_runs`, `evidence`. Evidence is the text the model was shown, not a summary. A failed turn is not saved, so memory never holds half a turn.

**Example, "has anything changed since Monday on those CRM tools?"** The engine resolves Monday and pulls that turn with its five saved sources. The model sees the old prices as read then, searches all five tools in one parallel call, compares each with the current page, and answers in three groups: changed, unchanged, could not verify. The new sources are saved, so the next "since" has a fresh baseline.

## The model: why Groq's gpt-oss-120b

Speed and tool-call reliability decide this, so I measured. In my testing `openai/gpt-oss-120b` on Groq started output in 0.5 to 2 s and made correct tool calls every time. `gemini-4-hydrogen` took 1.5 to 9 s to a first token, stalled or returned 503 several times, and its free tier allows 20 requests a day. The model sits behind one small interface (`llm.ts`) with the Groq and Gemini adapters in their own files, so changing it is an `.env` edit. The eval judge is the other family (Gemini), so it does not favour the agent's own style. Two habits of this model are handled in code, because the eval caught them: it writes citations as `【label】(url)` and emits non-breaking spaces (`tidy.ts` fixes both).

## Why this way

The agent must answer fast and recall the past correctly. Each choice follows from one of those.

- **Memory is resolved in code, before the model runs.** Date parsing and SQL are deterministic, so the same question and clock always select the same turns, in milliseconds. A memory tool would add a model round trip, and a model choosing what to recall can guess wrong.
- **One loop, one model, one tool.** Every extra model call adds seconds. A planner, router or verifier would add several calls to a turn one call can handle. Parallel queries inside the tool give a multi-step plan's breadth without the calls.
- **Raw evidence, not summaries.** "Changed since Monday" needs what was seen on Monday. Summaries lose the number that changed, and extracting facts puts a second model on the critical path.
- **Date and keyword recall, not embeddings, at this scale.** Questions about a personal history name a date or a distinctive word, which dates and full-text search find exactly, with no index to keep in sync.
- **A capped tool result.** Most of a turn's time is the model reading, so each page is cut to its most relevant excerpt.
- **Grounding in the prompt, backed by code.** Numbers must come from a page read, claims about the user only from what the user said, and links are checked against the sources read.
- **An injectable clock and seeded history.** Reviewers cannot wait a week, and it lets the eval check recall and abstention with code.

This is the shortest path that stays fast and correct at this scale. I have not benchmarked it against the alternatives; the claim is that nothing here can be removed without losing speed or correctness, and that heavier designs pay off only with a much larger history.

## Considered and rejected

- Multi-agent or planner/verifier pipelines, and LangGraph: extra latency, and there is no graph to orchestrate.
- Embeddings or a vector database as the main memory: a strong design for a long history, but at this size it adds misses and moving parts for no gain.
- Memory as a model-callable tool: breaks the one-tool rule and adds round trips.
- Entity tables (regex or model-filled), a background fact extractor, the BEAM paper's scratchpad of extracted facts: noisy, or a second model on the critical path, and the next turn must never depend on it.
- Gemini's Google Search grounding or Anthropic's native search tool: less control over what is stored as evidence.
- A smaller second model, or a router between two models: dates, titles and context are code, so nothing light is left to route.
- Tavily Search and Extract as two tools: merged into one `web_search`.

Embedding-first memory suits a very long history. This agent does not need it at its scale, where recall by date and keyword is exact and fast. The path for a long history is the next section.

## My idea for the in-house chat approach (future)

If Minimi builds its own chat system apart from the MCP options it offers today, this is the memory design I would build, and test with the same eval. It is not built here. It is meant for a long history, in three steps:

1. **Keyword search (BM25) over pure embeddings.** Searching the raw prompt and transcript text catches exact strings, commands and terms that dense vectors smooth over.
2. **Model re-ranking.** A strong model (Sonnet, say) re-ranks the top 10 candidates, so the exact right conversation lands at number one instead of trusting raw similarity scores.
3. **Agentic verification (ask / Grep / Read).** Instead of feeding the model a static, pre-summarised memory chunk, it spawns a read-only fork that actively searches and reads the raw transcript to verify exact facts before answering.

It builds on what the agent already does: it keeps raw text, not summaries, and its context step is where these steps would plug in without changing the loop.

## Evaluation

`npm run eval` runs 8 cases end to end on the real model: the three examples from the brief, "no record" cases (empty history, a day with nothing on it), small talk and a stable fact that must not search, and a changing fact that must. The clock is frozen, history seeded and web pages recorded, so every run sees the same world. Checks that can be code are code; a judge from another model family scores directness, citations and honesty.

**Result (14 Nov 2026): 27 of 27 checks pass. Judge 5/5/5 on six cases and 5/5/4 on one; the eighth could not be judged (Gemini quota).** Median 0.8 s to first output, 1.3 s total. It is a regression suite written while fixing earlier failures, not an independent benchmark. `npm run eval` regenerates `evals/RESULTS.md`.

## Free-tier workarounds (not part of the architecture)

The Gemini backup and the short waits exist only so a tester on free keys gets a smooth conversation. Free Groq allows 8,000 tokens a minute and one searching turn uses most of it, so two questions in a row can hit the limit. A wait of 10 seconds or less is waited out; a longer wait, a daily limit, or a request over the per-minute cap moves that turn to Gemini, and the page says which happened. With a paid key none of this triggers.

## With another week

- **Observability.** A Cytoscape graph of every run: each step (context, model call, search, read, answer) as a node with timings, tokens, rate-limit waits and errors, so a slow or failed turn can be traced at a glance. The eval would use the same view.
- **Promises said out loud.** A background process that picks up commitments from the chat ("remind me to send the email at 4") and speaks them at the right time, so the user does not forget or miss anything.
- **Voice.** Speaking to the agent and hearing it answer, as an option next to typing.
- **The in-house chat approach.** Build and test the three-step memory above (BM25, model re-rank, agentic verification) and run the eval on it.
