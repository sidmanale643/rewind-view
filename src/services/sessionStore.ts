/**
 * SessionStore
 * SQLite-backed checkpoint and search layer for discovered sessions.
 * Using better-sqlite3 for a synchronous, native SQLite (with FTS5 support).
 */

import { readFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join, resolve, dirname, sep } from "path";
import { execSync } from "child_process";
import Database from "better-sqlite3";
import { ParsedSession, Action, GrepResult } from "../models";
import { DEFAULT_DATA_DIR } from "../utils";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS seen_sessions (
    id TEXT PRIMARY KEY,

    provider TEXT NOT NULL,
    provider_session_id TEXT NOT NULL,
    title TEXT,
    summary TEXT,
    cwd TEXT,
    repo_root TEXT,
    message_count INTEGER,

    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_input_tokens INTEGER,
    cache_creation_tokens INTEGER,
    cache_creation_1h_tokens INTEGER,
    reasoning_tokens INTEGER,
    total_tokens INTEGER,
    git_branch TEXT,
    cli_version TEXT,

    source_path TEXT NOT NULL,
    source_mtime_ns INTEGER,
    source_size_bytes INTEGER,

    content_hash TEXT NOT NULL,
    indexed_content_hash TEXT,

    status TEXT NOT NULL DEFAULT 'discovered',

    vector_collection TEXT,
    vector_id TEXT,

    session_created_at TEXT,
    session_last_message_at TEXT,

    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_indexed_at TEXT,

    last_error TEXT,

    transcript_text TEXT,

    UNIQUE(provider, provider_session_id),
    UNIQUE(provider, source_path)
);

CREATE TABLE IF NOT EXISTS session_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    action_index INTEGER NOT NULL,
    action_type TEXT NOT NULL,
    action_target TEXT,
    action_input_json TEXT,
    timestamp TEXT,
    agent TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES seen_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_actions_session ON session_actions(session_id);

CREATE TABLE IF NOT EXISTS shared_sessions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    access_count INTEGER DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES seen_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shared_sessions_expires_at ON shared_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_shared_sessions_session_id ON shared_sessions(session_id);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
    provider_session_id,
    title,
    summary,
    cwd,
    repo_root,
    source_path,
    transcript_text,
    content='seen_sessions',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS seen_sessions_ai AFTER INSERT ON seen_sessions BEGIN
    INSERT INTO session_fts(
        rowid,
        provider_session_id,
        title,
        summary,
        cwd,
        repo_root,
        source_path,
        transcript_text
    ) VALUES (
        new.rowid,
        new.provider_session_id,
        new.title,
        new.summary,
        new.cwd,
        new.repo_root,
        new.source_path,
        new.transcript_text
    );
END;

CREATE TRIGGER IF NOT EXISTS seen_sessions_ad AFTER DELETE ON seen_sessions BEGIN
    INSERT INTO session_fts(
        session_fts,
        rowid,
        provider_session_id,
        title,
        summary,
        cwd,
        repo_root,
        source_path,
        transcript_text
    ) VALUES (
        'delete',
        old.rowid,
        old.provider_session_id,
        old.title,
        old.summary,
        old.cwd,
        old.repo_root,
        old.source_path,
        old.transcript_text
    );
END;

CREATE TRIGGER IF NOT EXISTS seen_sessions_au AFTER UPDATE ON seen_sessions BEGIN
    INSERT INTO session_fts(
        session_fts,
        rowid,
        provider_session_id,
        title,
        summary,
        cwd,
        repo_root,
        source_path,
        transcript_text
    ) VALUES (
        'delete',
        old.rowid,
        old.provider_session_id,
        old.title,
        old.summary,
        old.cwd,
        old.repo_root,
        old.source_path,
        old.transcript_text
    );
    INSERT INTO session_fts(
        rowid,
        provider_session_id,
        title,
        summary,
        cwd,
        repo_root,
        source_path,
        transcript_text
    ) VALUES (
        new.rowid,
        new.provider_session_id,
        new.title,
        new.summary,
        new.cwd,
        new.repo_root,
        new.source_path,
        new.transcript_text
    );
END;
`;

const MIGRATIONS = [
  "ALTER TABLE seen_sessions ADD COLUMN session_created_at TEXT",
  "ALTER TABLE seen_sessions ADD COLUMN session_last_message_at TEXT",
  "ALTER TABLE seen_sessions ADD COLUMN transcript_text TEXT",
  "ALTER TABLE seen_sessions ADD COLUMN title TEXT",
  "ALTER TABLE seen_sessions ADD COLUMN summary TEXT",
  "ALTER TABLE seen_sessions ADD COLUMN cwd TEXT",
  "ALTER TABLE seen_sessions ADD COLUMN repo_root TEXT",
  "ALTER TABLE seen_sessions ADD COLUMN message_count INTEGER",
  "ALTER TABLE seen_sessions ADD COLUMN model TEXT",
  "ALTER TABLE seen_sessions ADD COLUMN input_tokens INTEGER",
  "ALTER TABLE seen_sessions ADD COLUMN output_tokens INTEGER",
  "ALTER TABLE seen_sessions ADD COLUMN cached_input_tokens INTEGER",
  "ALTER TABLE seen_sessions ADD COLUMN cache_creation_tokens INTEGER",
  "ALTER TABLE seen_sessions ADD COLUMN cache_creation_1h_tokens INTEGER",
  "ALTER TABLE seen_sessions ADD COLUMN reasoning_tokens INTEGER",
  "ALTER TABLE seen_sessions ADD COLUMN total_tokens INTEGER",
  "ALTER TABLE seen_sessions ADD COLUMN git_branch TEXT",
  "ALTER TABLE seen_sessions ADD COLUMN cli_version TEXT",
];

function nowIso(): string {
  return new Date().toISOString();
}

export interface SessionListOptions {
  offset?: number;
  limit?: number;
  provider?: string | null;
  status?: string | null;
  sort?: string;
  sortDir?: string;
}

export interface Stats {
  total: number;
  byProvider: Record<string, number>;
  byStatus: Record<string, number>;
  ftsRows: number;
  messageCount?: number;
  totalTokens?: number;
  activity?: { date: string; count: number; tokens: number }[];
  models?: { model: string; tokens: number; sessions: number }[];
  topRepos?: { path: string; sessions: number; tokens: number }[];
}

export class SessionStore {
  private db: Database.Database;
  private dbPath: string;
  readonly currentRepoRoot: string | null;

  constructor(dataDir: string = DEFAULT_DATA_DIR) {
    this.dbPath = join(dataDir, "rewind.sqlite");
    mkdirSync(dataDir, { recursive: true });

    try {
      this.db = new Database(this.dbPath);
    } catch (err: any) {
      const msg =
        `Failed to open database at ${this.dbPath}\n\n` +
        "Rewind uses better-sqlite3 for fast local search.\n" +
        "Make sure you are running an active Node LTS version (v18+).\n" +
        "If no prebuilt binary is available for your platform, you may need\n" +
        "native build tools (Xcode/Build Tools on macOS, build-essential on Linux).\n\n" +
        `Platform: ${process.platform} ${process.arch}\n` +
        `Node: ${process.version}\n` +
        `Error: ${err.message || err}`;
      throw new Error(msg);
    }

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
    this.ensureFts();
    this.currentRepoRoot = this.detectRepoRoot();
  }

  private detectRepoRoot(): string | null {
    try {
      const cwd = process.cwd();
      let current = resolve(cwd);
      const visited = new Set<string>();
      while (current && !visited.has(current)) {
        visited.add(current);
        if (existsSync(join(current, ".git"))) {
          return current.split(sep).join("/");
        }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    } catch {
      // ignore
    }
    return null;
  }

  private migrate(): void {
    const rows = this.db
      .prepare("SELECT name FROM pragma_table_info('seen_sessions')")
      .all() as { name: string }[];
    const existing = new Set(rows.map((r) => r.name));

    for (const ddl of MIGRATIONS) {
      const match = ddl.match(/ADD COLUMN (\w+)/);
      if (match && !existing.has(match[1])) {
        this.db.exec(ddl);
      }
    }
  }

  private ensureFts(): void {
    this.db.exec(FTS_SCHEMA);
    try {
      this.db.exec("INSERT INTO session_fts(session_fts) VALUES('rebuild')");
    } catch {
      // FTS may not be empty yet
    }
  }

  rebuildFts(): void {
    try {
      this.db.exec("INSERT INTO session_fts(session_fts) VALUES('rebuild')");
    } catch {
      // ignore
    }
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  get(sessionId: string): any {
    return this.db
      .prepare("SELECT * FROM seen_sessions WHERE id = :id")
      .get({ id: sessionId });
  }

  shouldIndex(
    sessionId: string,
    contentHash: string,
    force: boolean = false,
  ): boolean {
    if (force) return true;
    const row = this.get(sessionId);
    if (!row) return true;
    return !(
      row.status === "indexed" && row.indexed_content_hash === contentHash
    );
  }

  isSourceUnchanged(
    provider: string,
    sourcePath: string,
    mtimeNs: bigint,
    sizeBytes: number,
    force: boolean = false,
  ): boolean {
    if (force) return false;
    const row = this.db
      .prepare(
        `SELECT status, source_mtime_ns, source_size_bytes, indexed_content_hash
         FROM seen_sessions
         WHERE provider = :provider AND source_path = :source_path`,
      )
      .get({ provider, source_path: sourcePath }) as
      | {
          status: string;
          source_mtime_ns: string | number | null;
          source_size_bytes: number | null;
          indexed_content_hash: string | null;
        }
      | undefined;

    if (!row || row.status !== "indexed" || !row.indexed_content_hash) {
      return false;
    }
    const storedMtimeRaw = String(row.source_mtime_ns ?? "0");
    const storedMtime = /^[0-9]+$/.test(storedMtimeRaw)
      ? BigInt(storedMtimeRaw)
      : BigInt(Math.trunc(Number(storedMtimeRaw) || 0));
    const delta =
      storedMtime > mtimeNs ? storedMtime - mtimeNs : mtimeNs - storedMtime;

    return Number(row.source_size_bytes ?? -1) === sizeBytes && delta <= 1_000_000n;
  }

  // ------------------------------------------------------------------
  // Mutations
  // ------------------------------------------------------------------

  markSeen(
    parsed: ParsedSession,
    source: { path: string; mtimeNs: bigint; sizeBytes: number },
    contentHash: string,
  ): void {
    const now = nowIso();
    const s = parsed.session;
    const createdAt = s.createdAt ? s.createdAt.toISOString() : null;
    const lastMsgAt = s.lastMessageAt ? s.lastMessageAt.toISOString() : null;

    const insert = this.db.prepare(`
      INSERT INTO seen_sessions (
        id, provider, provider_session_id,
        title, summary, cwd, repo_root, message_count,
        model, input_tokens, output_tokens, cached_input_tokens,
        cache_creation_tokens, cache_creation_1h_tokens, reasoning_tokens, total_tokens,
        git_branch, cli_version,
        source_path, source_mtime_ns, source_size_bytes,
        content_hash, indexed_content_hash,
        status,
        session_created_at, session_last_message_at,
        first_seen_at, last_seen_at,
        transcript_text
      ) VALUES (
        @id, @provider, @provider_session_id,
        @title, @summary, @cwd, @repo_root, @message_count,
        @model, @input_tokens, @output_tokens, @cached_input_tokens,
        @cache_creation_tokens, @cache_creation_1h_tokens,
        @reasoning_tokens, @total_tokens,
        @git_branch, @cli_version,
        @source_path, @source_mtime_ns, @source_size_bytes,
        @content_hash, NULL,
        'discovered',
        @session_created_at, @session_last_message_at,
        @first_seen_at, @last_seen_at,
        @transcript_text
      )
    `);

    const update = this.db.prepare(`
      UPDATE seen_sessions
      SET title = @title,
          summary = @summary,
          cwd = @cwd,
          repo_root = @repo_root,
          message_count = @message_count,
          model = @model,
          input_tokens = @input_tokens,
          output_tokens = @output_tokens,
          cached_input_tokens = @cached_input_tokens,
          cache_creation_tokens = @cache_creation_tokens,
          cache_creation_1h_tokens = @cache_creation_1h_tokens,
          reasoning_tokens = @reasoning_tokens,
          total_tokens = @total_tokens,
          git_branch = @git_branch,
          cli_version = @cli_version,
          source_path = @source_path,
          source_mtime_ns = @source_mtime_ns,
          source_size_bytes = @source_size_bytes,
          content_hash = @content_hash,
          session_created_at = @session_created_at,
          session_last_message_at = @session_last_message_at,
          last_seen_at = @last_seen_at,
          transcript_text = @transcript_text,
          status = CASE
            WHEN seen_sessions.status = 'indexed' THEN 'indexed'
            ELSE 'discovered'
          END
      WHERE id = @id
    `);

    const params = {
      id: s.id,
      provider: s.provider,
      provider_session_id: s.providerSessionId,
      title: s.title,
      summary: s.summary,
      cwd: s.cwd,
      repo_root: s.repoRoot,
      message_count: s.messageCount,
      model: s.model,
      input_tokens: s.inputTokens,
      output_tokens: s.outputTokens,
      cached_input_tokens: s.cachedInputTokens,
      cache_creation_tokens: s.cacheCreationTokens,
      cache_creation_1h_tokens: s.cacheCreation1hTokens,
      reasoning_tokens: s.reasoningTokens,
      total_tokens: s.totalTokens,
      git_branch: s.gitBranch,
      cli_version: s.cliVersion,
      source_path: source.path,
      source_mtime_ns: source.mtimeNs.toString(),
      source_size_bytes: source.sizeBytes,
      content_hash: contentHash,
      session_created_at: createdAt,
      session_last_message_at: lastMsgAt,
      first_seen_at: now,
      last_seen_at: now,
      transcript_text: parsed.transcriptText,
    };

    const tx = this.db.transaction((p: typeof params) => {
      try {
        insert.run(p);
      } catch {
        update.run(p);
      }
    });
    tx(params);
  }

  pruneMissingSources(provider: string, sourcePaths: string[]): number {
    if (sourcePaths.length === 0) return 0;

    const tx = this.db.transaction((paths: string[]) => {
      this.db.exec("CREATE TEMP TABLE IF NOT EXISTS current_source_paths(path TEXT PRIMARY KEY)");
      this.db.prepare("DELETE FROM current_source_paths").run();

      const insertPath = this.db.prepare(
        "INSERT OR IGNORE INTO current_source_paths(path) VALUES (?)",
      );
      for (const path of paths) {
        insertPath.run(path);
      }

      const result = this.db
        .prepare(
          `DELETE FROM seen_sessions
           WHERE provider = ?
             AND source_path NOT IN (SELECT path FROM current_source_paths)`,
        )
        .run(provider);

      this.db.prepare("DELETE FROM current_source_paths").run();
      return result.changes;
    });

    return tx(sourcePaths);
  }

  markIndexed(
    sessionId: string,
    contentHash: string,
    collection: string,
    vectorId: string,
  ): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE seen_sessions
         SET indexed_content_hash = @content_hash,
             status = 'indexed',
             vector_collection = @collection,
             vector_id = @vector_id,
             last_indexed_at = @last_indexed_at,
             last_seen_at = @last_seen_at,
             last_error = NULL
         WHERE id = @id`,
      )
      .run({
        content_hash: contentHash,
        collection,
        vector_id: vectorId,
        last_indexed_at: now,
        last_seen_at: now,
        id: sessionId,
      });
  }

  markFailed(sessionId: string, error: string): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE seen_sessions
         SET status = 'failed',
             last_error = @error,
             last_seen_at = @last_seen_at
         WHERE id = @id`,
      )
      .run({ error, last_seen_at: now, id: sessionId });
  }

  // ------------------------------------------------------------------
  // FTS
  // ------------------------------------------------------------------

  searchFts(
    query: string,
    options: {
      provider?: string | null;
      status?: string | null;
      limit?: number;
      offset?: number;
    } = {},
  ): any[] {
    if (!query.trim()) return [];

    const { provider, status, limit = 25, offset = 0 } = options;
    const { where, params } = this.buildFilters(provider, status);

    // BM25 column weights: provider_session_id, title, summary, cwd,
    // repo_root, source_path, transcript_text
    const bm25Weights = "1.0, 5.0, 3.0, 2.0, 2.0, 0.5, 1.0";

    const baseSql = `
      SELECT s.*, bm25(session_fts, ${bm25Weights}) AS bm25_rank,
             snippet(session_fts, 1, '>>>', '<<<', ' … ', 16) AS title_snippet,
             snippet(session_fts, 2, '>>>', '<<<', ' … ', 16) AS summary_snippet,
             snippet(session_fts, 6, '>>>', '<<<', ' … ', 16) AS transcript_snippet
      FROM session_fts
      JOIN seen_sessions s ON s.rowid = session_fts.rowid
      WHERE session_fts MATCH :query${where ? " AND " + where.substring(6) : ""}
      ORDER BY bm25_rank ASC
      LIMIT :ftsLimit OFFSET :offset
    `;

    const tryQuery = (q: string): any[] => {
      const stmt = this.db.prepare(baseSql);
      // Over-fetch to have enough candidates for re-ranking
      const ftsLimit = Math.max(limit * 4, 50);
      return stmt.all({ ...params, query: q, ftsLimit, offset }) as any[];
    };

    let rows: any[];
    try {
      rows = tryQuery(query);
    } catch {
      rows = tryQuery(this.prepareFtsQuery(query));
    }

    // Post-FTS re-ranking
    const ranked = rows.map((row) => {
      row._rank = this.searchRank(row, query);
      return row;
    });

    ranked.sort((a: any, b: any) => b._rank - a._rank);
    return ranked.slice(0, limit);
  }

  private searchRank(row: any, query: string): number {
    const queryLower = query.toLowerCase();
    const tokens = queryLower.split(/\s+/).filter(Boolean);
    let score = 0;

    // Field-weighted exact + fuzzy match (short fields only)
    const fieldWeights: [string, number][] = [
      ["title", 600],
      ["summary", 450],
      ["cwd", 350],
      ["repo_root", 350],
      ["source_path", 100],
    ];
    for (const [field, weight] of fieldWeights) {
      const val = row[field] || "";
      const valLower = val.toLowerCase();
      if (valLower.includes(queryLower)) {
        score += weight;
      } else if (field !== "source_path") {
        // Fuzzy match for short fields
        const fuzzy = this.fuzzyScore(queryLower, valLower);
        if (fuzzy > 0) {
          score += Math.round(weight * (fuzzy / 200));
        }
      }
    }

    // Per-token match bonus across all indexed fields
    const allFields = [
      row.title,
      row.summary,
      row.cwd,
      row.repo_root,
      row.source_path,
      row.transcript_text,
    ];
    for (const token of tokens) {
      for (const field of allFields) {
        if ((field || "").toLowerCase().includes(token)) {
          score += 40;
          break;
        }
      }
    }

    // Token overlap ratio (matched tokens / total tokens)
    if (tokens.length > 1) {
      const matchedTokens = tokens.filter((t) =>
        allFields.some((f) => (f || "").toLowerCase().includes(t)),
      );
      score += (matchedTokens.length / tokens.length) * 150;
    }

    // Recency bonus (days since last message, capped at 90)
    if (row.session_last_message_at) {
      const ageMs = Date.now() - Date.parse(row.session_last_message_at);
      const ageDays = Math.min(90, Math.max(0, ageMs / 86400000));
      score += (90 - ageDays) * 2;
    }

    // Current repo affinity boost
    if (
      this.currentRepoRoot &&
      row.repo_root &&
      row.repo_root === this.currentRepoRoot
    ) {
      score += 200;
    }

    // BM25 contribution (normalized: multiply by 10 to bring into range)
    const bm25 = row.bm25_rank;
    if (bm25 !== null && bm25 !== undefined) {
      score += -bm25 * 10;
    }

    return score;
  }

  countFts(
    query: string,
    options: {
      provider?: string | null;
      status?: string | null;
    } = {},
  ): number {
    if (!query.trim()) return 0;

    const { provider, status } = options;
    const { where, params } = this.buildFilters(provider, status);

    const baseSql = `
      SELECT COUNT(*) as count FROM session_fts
      JOIN seen_sessions s ON s.rowid = session_fts.rowid
      WHERE session_fts MATCH :query${where ? " AND " + where.substring(6) : ""}
    `;

    const tryQuery = (q: string): number => {
      const row = this.db.prepare(baseSql).get({ ...params, query: q }) as {
        count: number;
      };
      return row.count;
    };

    try {
      return tryQuery(query);
    } catch {
      return tryQuery(this.prepareFtsQuery(query));
    }
  }

  private prepareFtsQuery(query: string): string {
    const tokens = query.match(/[A-Za-z0-9_]+/g) || [];
    const unique = Array.from(new Set(tokens));
    return unique.map((t) => `"${t}"`).join(" OR ");
  }

  private prepareGrepFtsQuery(pattern: string): string {
    const literals = pattern.match(/[A-Za-z0-9_]+/g) || [];
    const unique = Array.from(new Set(literals));
    if (unique.length === 0) return "";
    return unique.map((t) => `"${t}"`).join(" OR ");
  }

  private fuzzyScore(term: string, field: string): number {
    if (!field || !term) return 0;
    const t = term.toLowerCase();
    const f = field.toLowerCase();

    // Exact substring match
    if (f.includes(t)) return 100;

    // Prefix match
    if (f.startsWith(t)) return 80;

    // Simple edit distance for short terms (<=8 chars)
    if (t.length <= 8) {
      const maxDist = Math.floor(t.length / 3);
      const dist = this.editDistance(t, f.substring(0, Math.max(t.length * 2, f.length)));
      if (dist <= maxDist) return Math.round(60 * (1 - dist / (t.length + 1)));
    }

    // Token overlap: check if any word boundary-delimited token starts with the term
    const words = f.split(/[\s_\-/]+/);
    for (const w of words) {
      if (w.startsWith(t)) return 50;
      if (t.length >= 4 && w.length >= 3) {
        const dist = this.editDistance(t, w);
        if (dist <= Math.floor(t.length / 4)) return 35;
      }
    }

    return 0;
  }

  private editDistance(a: string, b: string): number {
    const la = a.length;
    const lb = b.length;
    if (la === 0) return lb;
    if (lb === 0) return la;

    // Optimized for short strings: only compute needed diagonals
    const maxDist = Math.max(la, lb);
    let prev = new Int16Array(lb + 1);
    let curr = new Int16Array(lb + 1);

    for (let j = 0; j <= lb; j++) prev[j] = j;

    for (let i = 1; i <= la; i++) {
      curr[0] = i;
      for (let j = 1; j <= lb; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,       // deletion
          curr[j - 1] + 1,   // insertion
          prev[j - 1] + cost, // substitution
        );
      }
      [prev, curr] = [curr, prev];
    }
    return prev[lb];
  }

  // ------------------------------------------------------------------
  // Grep
  // ------------------------------------------------------------------

  grepSessions(
    pattern: string,
    options: {
      provider?: string | null;
      contextLines?: number;
      limit?: number;
    } = {},
  ): GrepResult[] {
    const { provider, contextLines = 1, limit = 50 } = options;

    if (!pattern.trim()) return [];

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }

    const ftsQuery = this.prepareGrepFtsQuery(pattern);
    const { where, params } = this.buildFilters(provider, null);
    const ftsWhere = where ? " AND " + where.substring(6) : "";

    let candidateIds: Set<number> | null = null;

    if (ftsQuery) {
      try {
        const ftsSql = `
          SELECT s.rowid
          FROM session_fts
          JOIN seen_sessions s ON s.rowid = session_fts.rowid
          WHERE session_fts MATCH :ftsQuery${ftsWhere}
          LIMIT :ftsLimit
        `;
        const ftsRows = this.db
          .prepare(ftsSql)
          .all({ ...params, ftsQuery, ftsLimit: limit * 3 }) as any[];
        candidateIds = new Set(ftsRows.map((r: any) => r.rowid));
      } catch {
        candidateIds = null;
      }
    }

    let rows: any[];
    if (candidateIds !== null) {
      if (candidateIds.size === 0) return [];
      const placeholders = Array.from(candidateIds)
        .map((_, i) => `@cid${i}`)
      const cidParams: Record<string, any> = {};
      const cidList = Array.from(candidateIds);
      for (let i = 0; i < cidList.length; i++) {
        cidParams[`cid${i}`] = cidList[i];
      }
      const sql = `SELECT * FROM seen_sessions WHERE rowid IN (${placeholders.join(", ")})`;
      rows = this.db.prepare(sql).all(cidParams) as any[];
    } else {
      const sql = `SELECT * FROM seen_sessions ${where}`;
      rows = this.db.prepare(sql).all(params) as any[];
    }

    const results: GrepResult[] = [];

    for (const row of rows) {
      const text =
        row.transcript_text ||
        this.readTranscriptFallback(row.source_path, row.provider);
      if (!text) continue;

      const lines = text.split("\n");
      const matchingIndices = new Set<number>();
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) matchingIndices.add(i);
      }
      if (matchingIndices.size === 0) continue;

      results.push({
        id: row.id,
        provider: row.provider,
        provider_session_id: row.provider_session_id,
        source_path: row.source_path,
        session_last_message_at: row.session_last_message_at,
        match_count: matchingIndices.size,
        snippets: this.grepSnippets(lines, matchingIndices, contextLines),
      });
    }

    results.sort((a, b) => b.match_count - a.match_count);
    return results.slice(0, limit);
  }

  private grepSnippets(
    lines: string[],
    matchingIndices: Set<number>,
    contextLines: number,
  ): string[] {
    if (matchingIndices.size === 0) return [];

    const sorted = Array.from(matchingIndices).sort((a, b) => a - b);
    const ranges: [number, number][] = [];

    for (const idx of sorted) {
      const start = Math.max(0, idx - contextLines);
      const end = Math.min(lines.length, idx + contextLines + 1);
      if (ranges.length > 0 && start <= ranges[ranges.length - 1][1]) {
        ranges[ranges.length - 1] = [
          ranges[ranges.length - 1][0],
          Math.max(ranges[ranges.length - 1][1], end),
        ];
      } else {
        ranges.push([start, end]);
      }
    }

    const snippets: string[] = [];
    for (const [start, end] of ranges) {
      const snippetLines: string[] = [];
      for (let j = start; j < end; j++) {
        const marker = matchingIndices.has(j) ? ">>>" : "   ";
        snippetLines.push(`${marker} ${String(j + 1).padStart(5)}: ${lines[j]}`);
      }
      snippets.push(snippetLines.join("\n"));
    }
    return snippets;
  }

  private readTranscriptFallback(sourcePath: string, provider: string): string {
    // Handle OpenCode virtual paths (opencode.db?session=xxx)
    if (sourcePath.includes("?session=") && provider === "opencode") {
      return ""; // Transcript fallback not supported for OpenCode virtual paths
    }

    if (provider === "antigravity") {
      sourcePath = join(sourcePath, ".system_generated", "logs", "transcript.jsonl");
    }

    if (!existsSync(sourcePath)) return "";
    try {
      if (!statSync(sourcePath).isFile()) return "";
    } catch {
      return "";
    }
    try {
      const content = readFileSync(sourcePath, "utf-8");
      const parts: string[] = [];

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          let text = "";

          if (provider === "codex") {
            const evt = obj.type;
            const payload = obj.payload || {};
            if (evt === "response_item") {
              const item = payload.type;
              const role = payload.role;
              if (
                item === "message" &&
                ["user", "assistant", "developer"].includes(role)
              ) {
                text = this.extractText(payload);
              } else if (item === "function_call") {
                const name = payload.name || "";
                const args = payload.arguments || "";
                text = `[tool: ${name}] ${args}`;
              } else if (item === "function_call_output") {
                text = payload.output || "";
              }
            }
          } else {
            const message = obj.message;
            if (typeof message === "object") {
              const content = message.content || "";
              if (typeof content === "string") {
                text = content;
              } else if (Array.isArray(content)) {
                for (const block of content) {
                  if (typeof block === "object" && block.type === "text") {
                    text += block.text + "\n";
                  } else if (
                    typeof block === "object" &&
                    block.type === "tool_use"
                  ) {
                    text += `[tool: ${block.name || ""}]\n`;
                  }
                }
              }
            } else if (typeof obj.content === "string") {
              text = obj.content;
            }
          }

          if (text.trim()) parts.push(text.trim());
        } catch {
          // skip invalid JSON
        }
      }
      return parts.join("\n");
    } catch {
      return "";
    }
  }

  private extractText(payload: any): string {
    const content = payload.content || "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const block of content) {
        if (block && typeof block === "object") {
          const btype = block.type;
          if (["text", "input_text", "output_text"].includes(btype)) {
            texts.push(block.text || "");
          }
        }
      }
      return texts.join("\n");
    }
    return "";
  }

  // ------------------------------------------------------------------
  // Query helpers (UI)
  // ------------------------------------------------------------------

  private readonly SORTABLE_COLS = new Set([
    "_rank",
    "provider",
    "status",
    "source_path",
    "source_size_bytes",
    "session_created_at",
    "session_last_message_at",
    "first_seen_at",
    "last_seen_at",
    "last_indexed_at",
    "model",
    "total_tokens",
  ]);

  listSessions(options: SessionListOptions = {}): any[] {
    const {
      offset = 0,
      limit = 25,
      provider,
      status,
      sort = "session_last_message_at",
      sortDir = "DESC",
    } = options;

    const { where, params } = this.buildFilters(provider, status);
    const col = this.SORTABLE_COLS.has(sort) ? sort : "session_last_message_at";
    const direction = sortDir.toUpperCase() === "ASC" ? "ASC" : "DESC";

    const sql = `SELECT * FROM seen_sessions ${where} ORDER BY ${col} ${direction} LIMIT :limit OFFSET :offset`;
    return this.db
      .prepare(sql)
      .all({ ...params, limit, offset }) as any[];
  }

  searchSessions(query: string, options: SessionListOptions = {}): any[] {
    const {
      offset = 0,
      limit = 25,
      provider,
      status,
      sort = "_rank",
      sortDir = "DESC",
    } = options;

    const rows = this.searchFts(query, {
      provider,
      status,
      limit,
      offset,
    });
    this.sortSessionRows(rows, sort, sortDir);
    return rows;
  }

  countSessions(provider?: string | null, status?: string | null): number {
    const { where, params } = this.buildFilters(provider, status);
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM seen_sessions ${where}`)
      .get(params) as { count: number };
    return row.count;
  }

  countSearch(
    query: string,
    provider?: string | null,
    status?: string | null,
  ): number {
    return this.countFts(query, { provider, status });
  }

  getStats(): Stats {
    const total = this.countSessions();

    const byProvider: Record<string, number> = {};
    for (const row of this.db
      .prepare(
        "SELECT provider, COUNT(*) as count FROM seen_sessions GROUP BY provider",
      )
      .all() as { provider: string; count: number }[]) {
      byProvider[row.provider] = row.count;
    }

    const byStatus: Record<string, number> = {};
    for (const row of this.db
      .prepare(
        "SELECT status, COUNT(*) as count FROM seen_sessions GROUP BY status",
      )
      .all() as { status: string; count: number }[]) {
      byStatus[row.status] = row.count;
    }

    const ftsResult = this.db
      .prepare("SELECT COUNT(*) as count FROM session_fts")
      .get() as { count: number };

    const agg = this.db
      .prepare(
        "SELECT COALESCE(SUM(message_count), 0) as messages, " +
        "COALESCE(SUM(total_tokens), 0) as total_tokens, " +
        "COALESCE(SUM(input_tokens), 0) as input_tokens, " +
        "COALESCE(SUM(output_tokens), 0) as output_tokens " +
        "FROM seen_sessions",
      )
      .get() as {
        messages: number;
        total_tokens: number;
        input_tokens: number;
        output_tokens: number;
      };

    const activity = this.db
      .prepare(
        `SELECT
           date(session_last_message_at) as date,
           COUNT(*) as count,
           COALESCE(SUM(total_tokens), 0) as total_tokens,
           COALESCE(SUM(input_tokens), 0) as input_tokens,
           COALESCE(SUM(output_tokens), 0) as output_tokens
         FROM seen_sessions
         WHERE session_last_message_at IS NOT NULL
         GROUP BY date(session_last_message_at)
         ORDER BY date(session_last_message_at) ASC`,
      )
      .all() as {
        date: string;
        count: number;
        total_tokens: number;
        input_tokens: number;
        output_tokens: number;
      }[];

    const models = this.db
      .prepare(
        `SELECT
           COALESCE(NULLIF(model, ''), 'unknown') as model,
           COALESCE(SUM(total_tokens), 0) as total_tokens,
           COALESCE(SUM(input_tokens), 0) as input_tokens,
           COALESCE(SUM(output_tokens), 0) as output_tokens,
           COUNT(*) as sessions
         FROM seen_sessions
         GROUP BY model
         ORDER BY COALESCE(SUM(total_tokens), 0) DESC, sessions DESC
         LIMIT 20`,
      )
      .all() as {
        model: string;
        total_tokens: number;
        input_tokens: number;
        output_tokens: number;
        sessions: number;
      }[];

    const topRepos = this.db
      .prepare(
        `SELECT
           COALESCE(NULLIF(repo_root, ''), NULLIF(cwd, ''), 'unknown') as path,
           COUNT(*) as sessions,
           COALESCE(SUM(total_tokens), 0) as total_tokens,
           COALESCE(SUM(input_tokens), 0) as input_tokens,
           COALESCE(SUM(output_tokens), 0) as output_tokens
         FROM seen_sessions
         GROUP BY path
         ORDER BY sessions DESC, COALESCE(SUM(total_tokens), 0) DESC
         LIMIT 8`,
      )
      .all() as {
        path: string;
        sessions: number;
        total_tokens: number;
        input_tokens: number;
        output_tokens: number;
      }[];

    return {
      total,
      byProvider,
      byStatus,
      ftsRows: ftsResult.count,
      messageCount: agg.messages,
      totalTokens:
        agg.total_tokens || (agg.input_tokens + agg.output_tokens) || 0,
      activity: activity.map((row) => ({
        date: row.date,
        count: row.count,
        tokens:
          row.total_tokens || (row.input_tokens + row.output_tokens) || 0,
      })),
      models: models.map((row) => ({
        model: row.model,
        tokens:
          row.total_tokens || (row.input_tokens + row.output_tokens) || 0,
        sessions: row.sessions,
      })),
      topRepos: topRepos.map((row) => ({
        path: row.path,
        sessions: row.sessions,
        tokens:
          row.total_tokens || (row.input_tokens + row.output_tokens) || 0,
      })),
    };
  }

  private sortSessionRows(rows: any[], sort: string, sortDir: string): void {
    if (!rows.length) return;
    // If sort is "_rank" (relevance), keep the searchRank order from searchFts
    if (sort === "_rank") return;
    const validSorts = [
      "session_last_message_at",
      "session_created_at",
      "first_seen_at",
      "last_seen_at",
      "last_indexed_at",
    ];
    const sortKey = validSorts.includes(sort)
      ? sort
      : "session_last_message_at";
    const direction = sortDir.toUpperCase() === "ASC" ? 1 : -1;
    rows.sort((a, b) => {
      const aVal = a[sortKey] || "";
      const bVal = b[sortKey] || "";
      if (aVal < bVal) return -1 * direction;
      if (aVal > bVal) return 1 * direction;
      return 0;
    });
  }

  private buildFilters(
    provider?: string | null,
    status?: string | null,
  ): { where: string; params: Record<string, any> } {
    const clauses: string[] = [];
    const params: Record<string, any> = {};

    if (provider) {
      clauses.push("provider = @provider");
      params.provider = provider;
    }
    if (status) {
      clauses.push("status = @status");
      params.status = status;
    }

    const where = clauses.length > 0 ? " WHERE " + clauses.join(" AND ") : "";
    return { where, params };
  }

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  storeActions(sessionId: string, actions: Action[]): void {
    const tx = this.db.transaction((sid: string, acts: Action[]) => {
      this.db
        .prepare("DELETE FROM session_actions WHERE session_id = :id")
        .run({ id: sid });

      if (acts.length === 0) return;

      const stmt = this.db.prepare(`
        INSERT INTO session_actions
          (session_id, action_index, action_type, action_target, action_input_json, timestamp, agent)
        VALUES
          (:session_id, :action_index, :action_type, :action_target, :action_input_json, :timestamp, :agent)
      `);

      for (const a of acts) {
        stmt.run({
          session_id: sid,
          action_index: a.actionIndex,
          action_type: a.actionType,
          action_target: a.actionTarget || "",
          action_input_json: a.actionInputJson || "{}",
          timestamp: a.timestamp || null,
          agent: a.agent,
        });
      }
    });
    tx(sessionId, actions);
  }

  getActions(sessionId: string): Action[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM session_actions WHERE session_id = :id ORDER BY action_index`,
      )
      .all({ id: sessionId }) as any[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      actionIndex: row.action_index,
      actionType: row.action_type,
      actionTarget: row.action_target,
      actionInputJson: row.action_input_json,
      timestamp: row.timestamp,
      agent: row.agent,
    }));
  }

  // ------------------------------------------------------------------
  // Share Links
  // ------------------------------------------------------------------

  createShareToken(
    sessionId: string,
    expiresHours: number = 168,
  ): { shareToken: string; expiresAt: string } | null {
    const session = this.get(sessionId);
    if (!session) return null;

    const { randomUUID } = require("crypto");
    const shareToken = randomUUID();
    const now = nowIso();
    const expiresAt = new Date(
      Date.now() + expiresHours * 60 * 60 * 1000,
    ).toISOString();

    this.db
      .prepare(
        `INSERT INTO shared_sessions (id, session_id, created_at, expires_at, access_count)
         VALUES (:id, :session_id, :created_at, :expires_at, 0)`,
      )
      .run({
        id: shareToken,
        session_id: sessionId,
        created_at: now,
        expires_at: expiresAt,
      });

    return { shareToken, expiresAt };
  }

  getSharedSession(shareToken: string): any {
    const now = nowIso();
    const row = this.db
      .prepare(
        `SELECT s.*, ss.created_at as share_created_at, ss.expires_at, ss.access_count
         FROM shared_sessions ss
         JOIN seen_sessions s ON s.id = ss.session_id
         WHERE ss.id = :token AND ss.expires_at > :now`,
      )
      .get({ token: shareToken, now }) as any;

    if (!row) return null;

    // Increment access count
    this.db
      .prepare(
        "UPDATE shared_sessions SET access_count = access_count + 1 WHERE id = :token",
      )
      .run({ token: shareToken });

    return row;
  }

  cleanupExpiredShares(): number {
    const now = nowIso();
    const result = this.db
      .prepare("DELETE FROM shared_sessions WHERE expires_at <= :now")
      .run({ now });
    return result.changes;
  }

  /**
   * Aggregate session token data grouped by model for cost estimation.
   * Returns per-model totals of all token fields plus session counts.
   */
  getSessionCosts(): Array<{
    model: string;
    provider: string;
    session_count: number;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    cache_creation_tokens: number;
    cache_creation_1h_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
  }> {
    return this.db
      .prepare(
        `SELECT
           COALESCE(NULLIF(model, ''), 'unknown') as model,
           provider,
           COUNT(*) as session_count,
           COALESCE(SUM(input_tokens), 0) as input_tokens,
           COALESCE(SUM(output_tokens), 0) as output_tokens,
           COALESCE(SUM(cached_input_tokens), 0) as cached_input_tokens,
           COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
           COALESCE(SUM(cache_creation_1h_tokens), 0) as cache_creation_1h_tokens,
           COALESCE(SUM(reasoning_tokens), 0) as reasoning_tokens,
           COALESCE(SUM(total_tokens), 0) as total_tokens
         FROM seen_sessions
         WHERE model IS NOT NULL AND model != ''
         GROUP BY model, provider
         ORDER BY COALESCE(SUM(total_tokens), 0) DESC`,
      )
      .all() as any[];
  }
}
