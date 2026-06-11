/**
 * Indexer
 * Orchestrates end-to-end ingestion of provider sessions into SQLite.
 */

import { createHash } from "crypto";
import {
  Provider,
  SourceFile,
  ParsedSession,
  IndexResult,
  SearchHit,
  Action,
} from "./models";
import { SessionStore } from "./services/sessionStore";
import { ClaudeAdapter } from "./connectors/claude";
import { CodexAdapter } from "./connectors/codex";
import { OpenCodeAdapter } from "./connectors/opencode";
import { AntigravityAdapter } from "./connectors/antigravity";
import { CursorAdapter } from "./connectors/cursor";
import { DEFAULT_DATA_DIR } from "./utils";

const DEFAULT_DIM = 384;
const DEFAULT_BIT_WIDTH = 4;
const SUPPORTED_PROVIDERS = [
  Provider.CLAUDE,
  Provider.CODEX,
  Provider.CURSOR,
  Provider.ANTIGRAVITY,
  Provider.OPENCODE,
];
const SQLITE_FTS_COLLECTION = "session_fts";

function transcriptHash(transcript: string): string {
  return (
    "sha256:" + createHash("sha256").update(transcript, "utf-8").digest("hex")
  );
}

function resumeCommandFor(
  provider: string,
  providerSessionId: string | null,
): string | null {
  if (!providerSessionId) return null;
  if (provider === "claude") return `claude --resume ${providerSessionId}`;
  if (provider === "codex") return `codex resume ${providerSessionId}`;
  if (provider === "cursor") return null; // Cursor doesn't have a resume CLI command
  return null;
}

interface IndexOptions {
  force?: boolean;
  discoverOnly?: boolean;
}

export class Indexer {
  readonly sessionStore: SessionStore;
  readonly dim: number;
  readonly bitWidth: number;
  private readonly dataDir: string;

  constructor(
    dataDir: string = DEFAULT_DATA_DIR,
    dim: number = DEFAULT_DIM,
    bitWidth: number = DEFAULT_BIT_WIDTH,
  ) {
    this.sessionStore = new SessionStore(dataDir);
    this.dim = dim;
    this.bitWidth = bitWidth;
    this.dataDir = dataDir;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  async indexProvider(
    provider: Provider,
    options: IndexOptions = {},
  ): Promise<IndexResult> {
    const adapter = this.makeAdapter(provider);
    const force = options.force || false;
    const discoverOnly = options.discoverOnly || false;

    const result: IndexResult = {
      provider: provider,
      collection: SQLITE_FTS_COLLECTION,
      discovered: 0,
      indexed: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    const sources = adapter.discover();
    result.discovered = sources.length;

    if (sources.length === 0) return result;

    // Discover + parse all sessions, record them in SQLite
    for (const source of sources) {
      try {
        const parsed = adapter.parse(source);
        const newHash = transcriptHash(parsed.transcriptText);

        await this.sessionStore.markSeen(
          parsed,
          {
            path: source.path,
            mtimeNs: source.mtimeNs,
            sizeBytes: source.sizeBytes,
          },
          newHash,
        );

        // Extract and store actions
        try {
          const actions = this.parseActions(
            source.path,
            provider,
            parsed.session.id,
          );
          await this.sessionStore.storeActions(parsed.session.id, actions);
        } catch {
          // Action parsing is best-effort
        }

        if (
          !(await this.sessionStore.shouldIndex(
            parsed.session.id,
            newHash,
            force,
          ))
        ) {
          result.skipped++;
          continue;
        }

        if (discoverOnly) continue;

        try {
          await this.sessionStore.markIndexed(
            parsed.session.id,
            newHash,
            SQLITE_FTS_COLLECTION,
            parsed.session.id,
          );
          result.indexed++;
        } catch (exc) {
          result.failed++;
          result.errors.push(`${source.path}: ${exc}`);
          await this.sessionStore.markFailed(
            parsed.session.id,
            exc instanceof Error ? exc.message : String(exc),
          );
        }
      } catch (exc) {
        result.failed++;
        result.errors.push(
          `${source.path}: ${exc instanceof Error ? exc.message : String(exc)}`,
        );
      }
    }

    return result;
  }

  async indexAll(options: IndexOptions = {}): Promise<IndexResult[]> {
    const results: IndexResult[] = [];
    for (const provider of SUPPORTED_PROVIDERS) {
      results.push(await this.indexProvider(provider, options));
    }
    return results;
  }

  // ------------------------------------------------------------------
  // Search
  // ------------------------------------------------------------------

  private hitFromSessionRow(row: any): SearchHit {
    const providerValue = row.provider || "";
    const providerSessionId = row.provider_session_id;
    const score = row._rank || 0;

    // Pick best snippet from per-column results
    const snippet =
      row.title_snippet ||
      row.summary_snippet ||
      row.transcript_snippet ||
      "";

    return {
      id: row.id,
      score,
      provider: providerValue,
      title: row.title,
      summary: row.summary,
      cwd: row.cwd,
      lastMessageAt: row.session_last_message_at,
      sourcePath: row.source_path,
      resumeCommand: resumeCommandFor(providerValue, providerSessionId),
      snippet,
      model: row.model || null,
      totalTokens: row.total_tokens || null,
    };
  }

  async search(
    query: string,
    provider?: Provider | null,
    k: number = 5,
  ): Promise<SearchHit[]> {
    if (!query.trim()) return [];

    const rows = await this.sessionStore.searchFts(query, {
      provider: provider ? provider : null,
      status: "indexed",
      limit: k,
      offset: 0,
    });

    return rows.map((row) => this.hitFromSessionRow(row));
  }

  async grep(
    pattern: string,
    provider?: Provider | null,
    contextLines: number = 1,
    limit: number = 50,
  ): Promise<any[]> {
    if (!pattern.trim()) return [];

    return this.sessionStore.grepSessions(pattern, {
      provider: provider ? provider : null,
      contextLines,
      limit,
    });
  }

  // ------------------------------------------------------------------
  // Info
  // ------------------------------------------------------------------

  async info(): Promise<any> {
    const stats = await this.sessionStore.getStats();
    return {
      dataDir: this.dataDir,
      sqlitePath: `${this.dataDir}/rewind.sqlite`,
      dim: this.dim,
      bitWidth: this.bitWidth,
      sessions: {
        total: stats.total,
        byProvider: stats.byProvider,
        byStatus: stats.byStatus,
      },
      fts: {
        enabled: true,
        rows: stats.ftsRows,
      },
    };
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  private makeAdapter(provider: Provider) {
    switch (provider) {
      case Provider.CLAUDE:
        return new ClaudeAdapter();
      case Provider.CODEX:
        return new CodexAdapter();
      case Provider.CURSOR:
        return new CursorAdapter();
      case Provider.ANTIGRAVITY:
        return new AntigravityAdapter();
      case Provider.OPENCODE:
        return new OpenCodeAdapter();
      default:
        throw new Error(`unsupported provider: ${provider}`);
    }
  }

  private parseActions(
    sourcePath: string,
    provider: Provider,
    sessionId: string,
  ): Action[] {
    const fs = require("fs");

    // Handle OpenCode virtual paths (opencode.db?session=xxx)
    if (sourcePath.includes("?session=") && provider === Provider.OPENCODE) {
      return []; // Action parsing not supported for OpenCode virtual paths
    }

    if (!fs.existsSync(sourcePath)) return [];

    try {
      if (provider === Provider.ANTIGRAVITY) {
        const transcriptPath = require("path").join(
          sourcePath,
          ".system_generated",
          "logs",
          "transcript.jsonl",
        );
        if (!fs.existsSync(transcriptPath)) return [];
        const content = fs.readFileSync(transcriptPath, "utf-8");
        return this.parseActionsFromContent(content, provider, sessionId);
      }
      const content = fs.readFileSync(sourcePath, "utf-8");
      return this.parseActionsFromContent(content, provider, sessionId);
    } catch {
      return [];
    }
  }

  private parseActionsFromContent(
    content: string,
    provider: Provider,
    sessionId: string,
  ): Action[] {
    const actions: Action[] = [];
    let actionIndex = 0;

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj: any;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (provider === Provider.CLAUDE || provider === Provider.CURSOR) {
        const message = obj.message;
        if (message && typeof message === "object") {
          const msgContent = message.content;
          if (Array.isArray(msgContent)) {
            for (const block of msgContent) {
              if (
                block &&
                typeof block === "object" &&
                block.type === "tool_use"
              ) {
                actions.push({
                  sessionId,
                  actionIndex: actionIndex++,
                  actionType: "tool_use",
                  actionTarget: this.summarizeToolTarget(block),
                  actionInputJson: JSON.stringify(block.input || {}),
                  timestamp: obj.timestamp || null,
                  agent: "claude",
                });
              }
            }
          }
        }
      } else if (provider === Provider.CODEX) {
        const eventType = obj.type;
        const payload = obj.payload || {};
        if (eventType === "response_item") {
          const itemType = payload.type;
          if (itemType === "function_call") {
            actions.push({
              sessionId,
              actionIndex: actionIndex++,
              actionType: "function_call",
              actionTarget: this.summarizeCodexTarget(payload),
              actionInputJson: JSON.stringify(payload.arguments || {}),
              timestamp: obj.timestamp || null,
              agent: "codex",
            });
          }
        }
      }
      if (provider === Provider.ANTIGRAVITY) {
        const entryType = obj.type || "";
        const timestamp = obj.created_at || null;

        if (entryType === "PLANNER_RESPONSE") {
          const toolCalls = obj.tool_calls || [];
          for (const tc of toolCalls) {
            const tcName = tc.name || "unknown";
            const tcArgs = tc.args || {};
            actions.push({
              sessionId,
              actionIndex: actionIndex++,
              actionType: this.normaliseAntigravityTool(tcName),
              actionTarget: this.summarizeAntigravityTarget(tcName, tcArgs),
              actionInputJson: JSON.stringify(tcArgs),
              timestamp,
              agent: "antigravity",
            });
          }
        }
      }
    }

    return actions;
  }

  private summarizeToolTarget(block: any): string {
    const input = block.input || {};
    return (
      input.command ||
      input.file_path ||
      input.path ||
      input.pattern ||
      input.query ||
      input.prompt ||
      ""
    ).toString();
  }

  private summarizeCodexTarget(payload: any): string {
    const args = payload.arguments || {};
    if (typeof args === "object" && args !== null) {
      return (
        args.cmd ||
        args.command ||
        args.file_path ||
        args.path ||
        args.pattern ||
        args.query ||
        args.prompt ||
        ""
      ).toString();
    }
    return "";
  }

  private normaliseAntigravityTool(name: string): string {
    const map: Record<string, string> = {
      list_dir: "glob",
      grep_search: "search",
      view_file: "read",
      run_command: "bash",
      code_action: "write",
    };
    return map[name] || name.toLowerCase();
  }

  private summarizeAntigravityTarget(name: string, args: any): string {
    if (name === "run_command") {
      const cmd = (args.Command || args.command || "").trim();
      return cmd.length > 80 ? cmd.substring(0, 77) + "..." : cmd;
    }
    if (name === "list_dir") {
      return (args.DirectoryPath || "").trim().replace(/^"|"$/g, "");
    }
    if (name === "grep_search") {
      return (args.Query || "").trim().replace(/^"|"$/g, "");
    }
    if (name === "view_file" || name === "code_action") {
      return (args.FilePath || args.file_path || "")
        .trim()
        .replace(/^"|"$/g, "");
    }
    for (const v of Object.values(args)) {
      if (typeof v === "string" && v.trim()) {
        const s = v.trim().replace(/^"|"$/g, "");
        return s.length > 80 ? s.substring(0, 77) + "..." : s;
      }
    }
    return "";
  }

  close(): void {
    this.sessionStore.close();
  }
}
