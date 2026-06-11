/**
 * OpenCode adapter: discovers and parses OpenCode session data
 * from the SQLite database (~/.local/share/opencode/opencode.db).
 */

import { existsSync, statSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { Provider, SourceFile, ParsedSession, SessionRecord } from '../models';
import {
  findRepoRoot,
  formatTranscriptLine,
  minimalRecord,
  normalizePath,
  parseUnixSeconds,
  previewFromText,
  truncateForDisplay,
} from '../utils';

const DEFAULT_OPENCODE_HOME = join(require('os').homedir(), '.local', 'share', 'opencode');
const DEFAULT_DB_PATH = join(DEFAULT_OPENCODE_HOME, 'opencode.db');

interface SessionMeta {
  id: string;
  title: string | null;
  directory: string | null;
  time_created: number;
  time_updated: number;
}

interface MessageRow {
  id: string;
  data: string;
  time_created: number;
}

interface PartRow {
  id: string;
  message_id: string;
  data: string;
}

function loadSessions(dbPath: string): SessionMeta[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, title, directory, time_created, time_updated
         FROM session
         WHERE time_archived IS NULL`,
      )
      .all() as SessionMeta[];
    return rows;
  } finally {
    db.close();
  }
}

function loadMessages(dbPath: string, sessionId: string): MessageRow[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT id, data, time_created
         FROM message
         WHERE session_id = ?
         ORDER BY time_created ASC`,
      )
      .all(sessionId) as MessageRow[];
  } finally {
    db.close();
  }
}

function loadParts(dbPath: string, sessionId: string): Map<string, PartRow[]> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, message_id, data
         FROM part
         WHERE session_id = ?
         ORDER BY time_created ASC`,
      )
      .all(sessionId) as PartRow[];

    const byMessage = new Map<string, PartRow[]>();
    for (const row of rows) {
      const list = byMessage.get(row.message_id) || [];
      list.push(row);
      byMessage.set(row.message_id, list);
    }
    return byMessage;
  } finally {
    db.close();
  }
}

function parseMessageData(dataStr: string): any {
  try {
    return JSON.parse(dataStr);
  } catch {
    return {};
  }
}

function parsePartData(dataStr: string): any {
  try {
    return JSON.parse(dataStr);
  } catch {
    return {};
  }
}

function formatOpencodeTool(data: any): string {
  const name = data.tool || 'unknown';
  const state = data.state || {};
  const inp = state.input || {};
  const output = state.output;

  const lines: string[] = [`[tool: ${name}]`];

  if (typeof inp === 'object' && inp !== null) {
    for (const [k, v] of Object.entries(inp)) {
      if (v === null) continue;
      const val = String(v).trim();
      lines.push(`  ${k}: ${val.length > 500 ? val.substring(0, 497) + '...' : val}`);
    }
  }

  if (output !== undefined && output !== null) {
    const trimmed = String(output).trim();
    lines.push(`  => ${trimmed.length > 1000 ? trimmed.substring(0, 997) + '...' : trimmed}`);
  }

  return lines.join('\n');
}

function extractTextFromParts(parts: PartRow[]): string {
  const texts: string[] = [];

  for (const part of parts) {
    const data = parsePartData(part.data);
    const ptype = data.type;

    if (ptype === 'text') {
      const text = data.text || '';
      if (text.trim()) {
        texts.push(text.trim());
      }
    } else if (ptype === 'tool') {
      texts.push(formatOpencodeTool(data));
    }
  }

  return texts.join('\n');
}

function sessionDataSize(dbPath: string, sessionId: string): number {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const messages = (
      db
        .prepare(`SELECT COUNT(*) as n FROM message WHERE session_id = ?`)
        .get(sessionId) as { n: number }
    ).n;
    const parts = (
      db
        .prepare(`SELECT COUNT(*) as n FROM part WHERE session_id = ?`)
        .get(sessionId) as { n: number }
    ).n;
    return messages * 256 + parts * 512;
  } finally {
    db.close();
  }
}

export interface OpenCodeAdapterOptions {
  dbPath?: string;
}

export class OpenCodeAdapter {
  readonly dbPath: string;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.dbPath = options.dbPath || DEFAULT_DB_PATH;
  }

  // ------------------------------------------------------------------
  // Discovery
  // ------------------------------------------------------------------

  discover(): SourceFile[] {
    if (!existsSync(this.dbPath)) return [];

    let sessions: SessionMeta[];
    try {
      sessions = loadSessions(this.dbPath);
    } catch {
      return [];
    }

    const files: SourceFile[] = [];

    for (const session of sessions) {
      const sessionId = session.id;
      const virtualPath = `${this.dbPath}?session=${sessionId}`;

      try {
        const stat = statSync(this.dbPath);
        const mtimeNs = BigInt(Math.floor(stat.mtimeMs * 1_000_000));
        const sizeBytes = sessionDataSize(this.dbPath, sessionId);

        files.push({
          provider: Provider.OPENCODE,
          path: virtualPath,
          mtimeNs,
          sizeBytes,
        });
      } catch {
        // Skip sessions that can't be read
      }
    }

    return files;
  }

  // ------------------------------------------------------------------
  // Parsing
  // ------------------------------------------------------------------

  parse(source: SourceFile): ParsedSession {
    try {
      // source.path is "db_path?session=session_id"
      const raw = source.path;
      const sessionId = raw.includes('session=') ? raw.split('session=')[1] : raw.split('/').pop() || '';
      return this.parseInner(sessionId);
    } catch (exc) {
      return minimalRecord(Provider.OPENCODE, source.path, exc instanceof Error ? exc.message : String(exc));
    }
  }

  private parseInner(sessionId: string): ParsedSession {
    // Load session metadata
    let sessions: SessionMeta[];
    try {
      sessions = loadSessions(this.dbPath);
    } catch (exc) {
      return minimalRecord(Provider.OPENCODE, `${this.dbPath}?session=${sessionId}`, exc instanceof Error ? exc.message : String(exc));
    }
    const sessionMeta = sessions.find(s => s.id === sessionId);

    if (!sessionMeta) {
      return minimalRecord(Provider.OPENCODE, `${this.dbPath}?session=${sessionId}`, `session ${sessionId} not found in database`);
    }

    // Load messages and parts
    const messages = loadMessages(this.dbPath, sessionId);
    const partsByMsg = loadParts(this.dbPath, sessionId);

    // Parse messages
    const transcriptLines: string[] = [];
    let firstUser: string | null = null;
    let lastUser: string | null = null;
    let messageCount = 0;

    for (const msg of messages) {
      const msgId = msg.id;
      const data = parseMessageData(msg.data);
      const role = data.role;

      if (role !== 'user' && role !== 'assistant') continue;

      // Extract text from parts
      const parts = partsByMsg.get(msgId) || [];
      const text = extractTextFromParts(parts);

      if (!text.trim()) continue;

      messageCount++;
      const ts = msg.time_created ? parseUnixSeconds(Math.floor(msg.time_created / 1000)) : null;

      if (role === 'user') {
        if (firstUser === null) firstUser = text;
        lastUser = text;
      }

      transcriptLines.push(formatTranscriptLine(role, ts, text));
    }

    // Derive title and metadata
    const titleRaw = sessionMeta.title || firstUser;
    const title = titleRaw ? truncateForDisplay(titleRaw, 100) : null;

    const summaryRaw = firstUser;
    const summary = summaryRaw ? truncateForDisplay(summaryRaw, 180) : null;

    const cwd = sessionMeta.directory || null;
    const repoRoot = cwd ? findRepoRoot(cwd) : null;

    const createdAt = sessionMeta.time_created ? parseUnixSeconds(Math.floor(sessionMeta.time_created / 1000)) : null;
    const updatedAt = sessionMeta.time_updated ? parseUnixSeconds(Math.floor(sessionMeta.time_updated / 1000)) : null;

    const previewRaw = lastUser || firstUser;
    const preview = previewRaw ? previewFromText(previewRaw) : '(no preview available)';

    const rawMetadataJson = JSON.stringify({
      sessionId,
      dbPath: normalizePath(this.dbPath),
      messageCount,
    });

    const session: SessionRecord = {
      id: `opencode:${sessionId}`,
      provider: Provider.OPENCODE,
      providerSessionId: sessionId,
      title,
      summary,
      cwd,
      repoRoot,
      createdAt,
      updatedAt,
      lastMessageAt: updatedAt,
      previewText: preview,
      sourcePath: `${normalizePath(this.dbPath)}?session=${sessionId}`,
      messageCount,
      model: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      cacheCreationTokens: null,
      cacheCreation1hTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      gitBranch: null,
      cliVersion: null,
      parseVersion: 'opencode-v1',
      rawMetadataJson,
      parseWarning: null,
      discoverySource: 'sqlite',
    };

    return {
      session,
      transcriptText: transcriptLines.join('\n\n'),
    };
  }
}
