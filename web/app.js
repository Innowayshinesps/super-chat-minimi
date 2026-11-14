import { marked } from '/vendor/marked.js';

// Answers contain text that came from web pages. Raw HTML and images are never
// rendered, and links must be http(s), so a page cannot inject markup into the chat.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }) { return esc(text); },
    image({ text }) { return esc(text || ''); },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      if (!/^https?:\/\//i.test(href)) return inner;
      return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''} target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
  },
});
const md = (text) => marked.parse(text, { async: false });

const $ = (id) => document.getElementById(id);
const els = {
  sidebar: $('sidebar'), chatList: $('chatList'), messages: $('messages'), title: $('title'),
  input: $('input'), composer: $('composer'), send: $('send'), stop: $('stop'),
  clock: $('clock'), model: $('model'), newChat: $('newChat'), menu: $('menu'),
};

const state = { chatId: null, busy: false, controller: null, info: null, chats: [] };

const EXAMPLES = [
  'Compare the current pricing of Supabase, Neon and Railway for a small Postgres app.',
  'What did I ask you last Tuesday?',
  'Has anything changed since we last talked about those?',
];

function fmtMs(ms) { return ms == null ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`; }
function fmtDate(iso, withTime = false) {
  const o = { timeZone: state.info?.tz, day: 'numeric', month: 'short', year: 'numeric' };
  if (withTime) Object.assign(o, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return new Intl.DateTimeFormat('en-GB', o).format(new Date(iso));
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function link(href, text) {
  const a = el('a', null, text);
  if (/^https?:\/\//i.test(href)) { a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  return a;
}

// ---------- scrolling ----------
function nearBottom() { const m = els.messages; return m.scrollHeight - m.scrollTop - m.clientHeight < 80; }
function scrollDown(force) { if (force || nearBottom()) els.messages.scrollTop = els.messages.scrollHeight; }

// ---------- sidebar ----------
function renderChats() {
  els.chatList.replaceChildren();
  for (const c of state.chats) {
    const b = el('button', 'chat-item' + (c.id === state.chatId ? ' active' : ''));
    b.append(el('span', 't', c.title), el('span', 'd', `${fmtDate(c.last_at)} · ${c.turns} turn${c.turns === 1 ? '' : 's'}`));
    b.onclick = () => { openChat(c.id); els.sidebar.classList.remove('open'); };
    els.chatList.append(b);
  }
}
async function refreshChats() {
  const r = await fetch('/api/chats');
  state.chats = (await r.json()).chats;
  renderChats();
}

// ---------- message rendering ----------
function inner() {
  let i = els.messages.querySelector('.inner');
  if (!i) { els.messages.replaceChildren(); i = el('div', 'inner'); els.messages.append(i); }
  return i;
}
function showEmpty() {
  els.messages.replaceChildren();
  const box = el('div', 'empty');
  box.append(el('h1', null, 'What do you want to know?'), el('p', null, 'I search the web when a fact may have changed, and I remember what we looked at before.'));
  const list = el('div', 'examples');
  for (const t of EXAMPLES) {
    const b = el('button', 'example', t);
    b.onclick = () => { els.input.value = t; els.input.focus(); autosize(); };
    list.append(b);
  }
  box.append(list);
  els.messages.append(box);
}

function userBubble(text) {
  const m = el('div', 'msg user');
  m.append(el('div', 'bubble', text));
  inner().append(m);
  return m;
}

function usedPanel({ debug, searches }) {
  const body = el('div', 'body');
  const section = (title) => { const s = el('div'); s.append(el('h4', null, title)); body.append(s); return s; };

  if (debug) {
    const s = section('Memory');
    const ul = el('ul');
    ul.append(el('li', null, `Today: ${debug.today} (${debug.tz})`));
    for (const r of debug.dateRefs) {
      ul.append(el('li', null, `"${r.phrase}" → ${r.label}${r.usedAlt ? ' (other reading used)' : ''}: ${r.turns} earlier turn${r.turns === 1 ? '' : 's'}`));
    }
    for (const t of debug.exactTurns) ul.append(el('li', null, `Recalled ${fmtDate(t.at, true)}: "${t.question}"${t.withEvidence ? ' + saved sources' : ''}`));
    for (const t of debug.relatedTurns) ul.append(el('li', null, `Related ${fmtDate(t.at, true)}: "${t.question}"`));
    if (debug.historyMessages) ul.append(el('li', null, `This chat: ${debug.historyMessages} message${debug.historyMessages === 1 ? '' : 's'} in context`));
    if (debug.indexChats) ul.append(el('li', null, `Index of ${debug.indexChats} other chat${debug.indexChats === 1 ? '' : 's'}`));
    for (const n of debug.notes) ul.append(el('li', null, n));
    if (debug.trimmed.length) ul.append(el('li', null, `Left out (budget): ${debug.trimmed.join('; ')}`));
    s.append(ul);
  }
  if (searches.length) {
    const s = section('Searches and sources');
    for (const q of searches) {
      const d = el('div');
      const head = el('div');
      head.append(el('strong', null, (q.queries ? q.queries.join(' · ') : q.query)));
      if (q.freshness && q.freshness !== 'any') head.append(' ', el('span', 'pill', `recent: ${q.freshness}`));
      d.append(head);
      const ul = el('ul');
      for (const src of q.sources ?? []) {
        const li = el('li');
        li.append(link(src.url, src.title || src.url));
        li.append(el('span', null, src.published_date ? `  ·  ${src.published_date}` : ''));
        ul.append(li);
      }
      d.append(ul);
      s.append(d);
    }
  }
  if (!body.children.length) return null;
  const det = el('details', 'used');
  det.append(el('summary', null, 'What I used'), body);
  return det;
}

function metaLine({ totalMs, ttftMs, searches, at }) {
  const m = el('div', 'meta');
  if (at) m.append(el('span', null, fmtDate(at, true)));
  if (totalMs != null) m.append(el('span', null, `${fmtMs(totalMs)} total`));
  if (ttftMs != null) m.append(el('span', null, `${fmtMs(ttftMs)} to first output`));
  if (searches != null) m.append(el('span', null, `${searches} search${searches === 1 ? '' : 'es'}`));
  return m;
}

function renderSavedMessage(msg) {
  if (msg.role === 'user') { userBubble(msg.content); return; }
  const m = el('div', 'msg assistant');
  const a = el('div', 'answer');
  a.innerHTML = md(msg.content);
  m.append(a);
  const searches = (msg.searches ?? []).map((s) => ({ queries: [s.query], sources: s.sources }));
  m.append(metaLine({ totalMs: msg.total_ms, ttftMs: msg.ttft_ms, searches: searches.length, at: msg.created_at }));
  const used = usedPanel({ searches });
  if (used) m.append(used);
  inner().append(m);
}

// ---------- chats ----------
async function openChat(id) {
  if (state.busy) return;
  const r = await fetch(`/api/chats/${encodeURIComponent(id)}`);
  if (!r.ok) return newChat();
  const { chat, messages } = await r.json();
  state.chatId = chat.id;
  els.title.textContent = chat.title;
  els.messages.replaceChildren();
  inner();
  for (const m of messages) renderSavedMessage(m);
  history.replaceState(null, '', `#${chat.id}`);
  renderChats();
  scrollDown(true);
}
function newChat() {
  if (state.busy) return;
  state.chatId = null;
  els.title.textContent = 'New chat';
  history.replaceState(null, '', location.pathname);
  showEmpty();
  renderChats();
  els.input.focus();
}

// ---------- sending ----------
function setBusy(b) {
  state.busy = b;
  els.send.hidden = b;
  els.stop.hidden = !b;
  els.input.disabled = false;
}

async function send(text) {
  if (state.busy || !text.trim()) return;
  setBusy(true);
  userBubble(text);
  const msg = el('div', 'msg assistant');
  const status = el('div', 'status');
  status.append(el('span', 'dot'), el('span', 'label', 'Checking what I know…'));
  const ans = el('div', 'answer');
  msg.append(status, ans);
  inner().append(msg);
  scrollDown(true);

  const label = (t) => { status.querySelector('.label').textContent = t; };
  let debug = null;
  const batches = [];
  let full = '';
  let queued = false;
  const paint = () => {
    queued = false;
    const stick = nearBottom();
    ans.innerHTML = md(full);
    if (stick) scrollDown(true);
  };

  const ctrl = new AbortController();
  state.controller = ctrl;
  let finished = false;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: state.chatId, message: text }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = /^event: (.+)$/m.exec(raw)?.[1];
        const dataLine = /^data: (.+)$/m.exec(raw)?.[1];
        if (!type || !dataLine) continue;
        const e = JSON.parse(dataLine);
        if (type === 'chat') {
          state.chatId = e.id;
          els.title.textContent = e.title;
          history.replaceState(null, '', `#${e.id}`);
        } else if (type === 'context') {
          debug = e.debug;
          const n = debug.exactTurns.length + debug.relatedTurns.length;
          label(n ? `Recalled ${n} earlier turn${n === 1 ? '' : 's'}. Thinking…` : 'Thinking…');
        } else if (type === 'search') {
          batches.push({ queries: e.queries, freshness: e.freshness, sources: null });
          label(`Searching: ${e.queries.join(' · ')}`);
        } else if (type === 'sources') {
          const b = batches.find((x) => !x.sources);
          if (b) b.sources = e.sources;
          label(`Reading ${e.sources.length} source${e.sources.length === 1 ? '' : 's'}…`);
        } else if (type === 'notice') {
          label(e.text);
        } else if (type === 'wait') {
          label(`Rate limited by the model provider. Continuing in ${e.seconds} s…`);
        } else if (type === 'delta') {
          full += e.text;
          if (!queued) { queued = true; requestAnimationFrame(paint); }
          label('Writing…');
        } else if (type === 'error') {
          msg.append(el('div', 'error', e.message));
          finished = true;
        } else if (type === 'done') {
          finished = true;
          if (e.text) full = e.text; // the cleaned-up final text replaces what streamed
          paint();
          status.remove();
          msg.append(metaLine({ totalMs: e.totalMs, ttftMs: e.ttftMs, searches: e.searches }));
          const used = usedPanel({ debug, searches: batches });
          if (used) msg.append(used);
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') msg.append(el('div', 'error', err.message || 'Something went wrong.'));
  } finally {
    if (!finished) {
      paint();
      if (ctrl.signal.aborted) msg.append(el('div', 'meta', 'Stopped.'));
    }
    status.remove();
    state.controller = null;
    setBusy(false);
    await refreshChats().catch(() => {});
    els.input.focus();
  }
}

// ---------- wiring ----------
function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 180) + 'px';
}
els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); els.composer.requestSubmit(); }
});
els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = els.input.value;
  if (!t.trim() || state.busy) return;
  els.input.value = '';
  autosize();
  send(t);
});
els.stop.onclick = () => state.controller?.abort();
els.newChat.onclick = () => { newChat(); els.sidebar.classList.remove('open'); };
els.menu.onclick = () => els.sidebar.classList.toggle('open');

async function init() {
  const info = await (await fetch('/api/info')).json();
  state.info = info;
  els.clock.replaceChildren(document.createTextNode(`${info.nowLabel}`));
  if (info.simulated) els.clock.append(el('span', 'sim', 'simulated clock'));
  els.model.textContent = `${info.model} (${info.provider}) · ${info.tz}`;
  await refreshChats();
  const id = location.hash.slice(1);
  if (id && state.chats.some((c) => c.id === id)) await openChat(id);
  else showEmpty();
}
init().catch((e) => { els.messages.replaceChildren(el('div', 'error', `Could not start: ${e.message}`)); });
