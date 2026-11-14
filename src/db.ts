import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Append-only store. Rows are only ever inserted, never updated or deleted,
 * so what the agent saw on a given day stays exactly as it was.
 *
 *   chats(id, title, created_at)
 *   messages(id, chat_id, role, content, created_at, ...timings)
 *   search_runs(id, message_id, query, retrieved_at)
 *   evidence(id, search_run_id, url, title, published_date, content_excerpt)
 */

export type Role = 'user' | 'assistant';

export interface MessageRow {
  id: string;
  chat_id: string;
  role: Role;
  content: string;
  created_at: string; // ISO, UTC
  ttft_ms: number | null;
  total_ms: number | null;
}

export interface EvidenceRow {
  id: string;
  search_run_id: string;
  url: string;
  title: string;
  published_date: string | null;
  content_excerpt: string;
}

export interface SearchRunRow {
  id: string;
  message_id: string;
  query: string;
  retrieved_at: string;
}

export interface ChatRow {
  id: string;
  title: string;
  created_at: string;
}

export interface TurnBundle {
  question: MessageRow | null;
  answer: MessageRow;
  runs: Array<SearchRunRow & { evidence: EvidenceRow[] }>;
}

export interface NewEvidence {
  url: string;
  title: string;
  published_date: string | null;
  content_excerpt: string;
}

export interface NewTurn {
  chatId: string;
  userId?: string;
  assistantId?: string;
  userText: string;
  assistantText: string;
  userAt: Date;
  assistantAt: Date;
  ttftMs?: number | null;
  totalMs?: number | null;
  searches: Array<{ query: string; retrievedAt: Date; evidence: NewEvidence[] }>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ttft_ms INTEGER,
  total_ms INTEGER
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS messages_time ON messages(created_at);
CREATE TABLE IF NOT EXISTS search_runs (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  query TEXT NOT NULL,
  retrieved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS search_runs_message ON search_runs(message_id);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  search_run_id TEXT NOT NULL REFERENCES search_runs(id),
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  published_date TEXT,
  content_excerpt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_run ON evidence(search_run_id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content='messages', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

export function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= 60 ? clean : clean.slice(0, 57).trimEnd() + '...';
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  createChat(title: string, at: Date, id: string = randomUUID()): ChatRow {
    this.db.prepare('INSERT INTO chats(id, title, created_at) VALUES (?,?,?)').run(id, title, at.toISOString());
    return { id, title, created_at: at.toISOString() };
  }

  getChat(id: string): ChatRow | undefined {
    return this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as unknown as ChatRow | undefined;
  }

  /** Chats, newest activity first. */
  listChats(): Array<ChatRow & { last_at: string; turns: number }> {
    return this.db
      .prepare(
        `SELECT c.id, c.title, c.created_at,
                COALESCE(MAX(m.created_at), c.created_at) AS last_at,
                COUNT(CASE WHEN m.role = 'user' THEN 1 END) AS turns
           FROM chats c LEFT JOIN messages m ON m.chat_id = c.id
          GROUP BY c.id ORDER BY last_at DESC`,
      )
      .all() as unknown as Array<ChatRow & { last_at: string; turns: number }>;
  }

  chatMessages(chatId: string): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at, rowid')
      .all(chatId) as unknown as MessageRow[];
  }

  messagesInRange(start: Date, end: Date, limit = 200): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE created_at >= ? AND created_at < ? ORDER BY created_at, rowid LIMIT ?')
      .all(start.toISOString(), end.toISOString(), limit) as unknown as MessageRow[];
  }

  firstMessageAt(): string | null {
    const r = this.db.prepare('SELECT MIN(created_at) AS t FROM messages').get() as unknown as { t: string | null };
    return r.t;
  }

  messageCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as unknown as { n: number }).n;
  }

  /** Full-text search over message text. `terms` are plain words; they are OR-ed. */
  searchMessages(terms: string[], limit = 12): MessageRow[] {
    const safe = terms
      .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
      .filter((t) => t.length > 1)
      .map((t) => `"${t}"`);
    if (!safe.length) return [];
    return this.db
      .prepare(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
          WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT ?`,
      )
      .all(safe.join(' OR '), limit) as unknown as MessageRow[];
  }

  /** The user message that came right before this message in its chat. */
  questionFor(answer: MessageRow): MessageRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM messages WHERE chat_id = ? AND role = 'user'
             AND (created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM messages WHERE id = ?)))
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(answer.chat_id, answer.created_at, answer.created_at, answer.id) as unknown as MessageRow | undefined) ?? null
    );
  }

  /** The assistant message that answered this user message. */
  answerFor(question: MessageRow): MessageRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM messages WHERE chat_id = ? AND role = 'assistant'
             AND (created_at > ? OR (created_at = ? AND rowid > (SELECT rowid FROM messages WHERE id = ?)))
           ORDER BY created_at, rowid LIMIT 1`,
        )
        .get(question.chat_id, question.created_at, question.created_at, question.id) as unknown as MessageRow | undefined) ??
      null
    );
  }

  runsFor(messageId: string): Array<SearchRunRow & { evidence: EvidenceRow[] }> {
    const runs = this.db
      .prepare('SELECT * FROM search_runs WHERE message_id = ? ORDER BY retrieved_at, rowid')
      .all(messageId) as unknown as SearchRunRow[];
    const ev = this.db.prepare('SELECT * FROM evidence WHERE search_run_id = ? ORDER BY rowid');
    return runs.map((r) => ({ ...r, evidence: ev.all(r.id) as unknown as EvidenceRow[] }));
  }

  /** A turn as one unit: the question, what was searched and read, and the answer. */
  bundleFor(answer: MessageRow): TurnBundle {
    return { question: this.questionFor(answer), answer, runs: this.runsFor(answer.id) };
  }

  /** Save one finished turn in a single transaction. Returns the new ids. */
  saveTurn(turn: NewTurn): { userId: string; assistantId: string } {
    const userId = turn.userId ?? randomUUID();
    const assistantId = turn.assistantId ?? randomUUID();
    const insMsg = this.db.prepare(
      'INSERT INTO messages(id, chat_id, role, content, created_at, ttft_ms, total_ms) VALUES (?,?,?,?,?,?,?)',
    );
    const insRun = this.db.prepare('INSERT INTO search_runs(id, message_id, query, retrieved_at) VALUES (?,?,?,?)');
    const insEv = this.db.prepare(
      'INSERT INTO evidence(id, search_run_id, url, title, published_date, content_excerpt) VALUES (?,?,?,?,?,?)',
    );
    this.db.exec('BEGIN');
    try {
      insMsg.run(userId, turn.chatId, 'user', turn.userText, turn.userAt.toISOString(), null, null);
      insMsg.run(
        assistantId,
        turn.chatId,
        'assistant',
        turn.assistantText,
        turn.assistantAt.toISOString(),
        turn.ttftMs ?? null,
        turn.totalMs ?? null,
      );
      for (const s of turn.searches) {
        const runId = randomUUID();
        insRun.run(runId, assistantId, s.query, s.retrievedAt.toISOString());
        for (const e of s.evidence) {
          insEv.run(randomUUID(), runId, e.url, e.title, e.published_date, e.content_excerpt);
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { userId, assistantId };
  }
}
