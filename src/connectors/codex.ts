/**
 * Codex adapter: discovers and parses Codex JSONL session files.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, normalize, sep } from 'path';
import { Provider, SourceFile, ParsedSession, SessionRecord } from '../models';
import {
  extractText,
  findRepoRoot,
  formatTranscriptLine,
  minimalRecord,
  normalizePath,
  parseDateTime,
  parseUnixSeconds,
  previewFromText,
  truncateForDisplay,
} from '../utils';

interface CodexMetadata {
  title?: string | null;
  cwd?: string | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
  rolloutPath?: string | null;
  firstUserMessage?: string | null;
  model?: string | null;
  tokensUsed?: number | null;
  gitBranch?: string | null;
  gitSha?: string | null;
  reasoningEffort?: string | null;
  cliVersion?: string | null;
  source?: string | null;
}

const ID_RE = /([0-9a-f]{8}-[0-9a-f\-]{27})\.jsonl$/;

function summarizeToolInput(name: string, argsStr: string): string {
  try {
    const args = JSON.parse(argsStr);
    if (typeof args === 'object' && args !== null) {
      const target =
        args.cmd ||
        args.command ||
        args.file_path ||
        args.path ||
        args.pattern ||
        args.query ||
        args.prompt ||
        '';

      if (target) {
        const strTarget = String(target).trim();
        return `${name} ${strTarget.length > 120 ? strTarget.substring(0, 117) + '...' : strTarget}`;
      }
    }
  } catch {
    // Fall through
  }
  return name;
}

function formatFunctionCall(name: string, argsStr: string, output?: string | null): string {
  try {
    const args = JSON.parse(argsStr);
  } catch {
    // Ignore parse errors
  }

  const lines: string[] = [`[tool: ${name}]`];

  try {
    const args = JSON.parse(argsStr);
    if (typeof args === 'object' && args !== null) {
      for (const [k, v] of Object.entries(args)) {
        if (v === null) continue;
        const val = String(v).trim();
        lines.push(`  ${k}: ${val.length > 500 ? val.substring(0, 497) + '...' : val}`);
      }
    }
  } catch {
    // Ignore parse errors
  }

  if (output !== undefined && output !== null) {
    const trimmed = output.trim();
    lines.push(`  => ${trimmed.length > 1000 ? trimmed.substring(0, 997) + '...' : trimmed}`);
  }

  return lines.join('\n');
}

function loadThreads(path: string): Map<string, CodexMetadata> {
  if (!existsSync(path)) return new Map();
  let Database: any;
  try {
    Database = require('better-sqlite3');
  } catch {
    return new Map();
  }
  let db: any;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    return new Map();
  }
  try {
    const result = new Map<string, CodexMetadata>();
    let rows: any[] = [];
    try {
      rows = db
        .prepare(`SELECT id, json_extract(json, '$.title') as title,
                         json_extract(json, '$.cwd') as cwd,
                         json_extract(json, '$.createdAt') as createdAt,
                         json_extract(json, '$.updatedAt') as updatedAt,
                         json_extract(json, '$.rolloutPath') as rolloutPath,
                         json_extract(json, '$.firstUserMessage') as firstUserMessage,
                         json_extract(json, '$.model') as model,
                         json_extract(json, '$.tokens_used') as tokensUsed,
                         json_extract(json, '$.git_branch') as gitBranch,
                         json_extract(json, '$.git_sha') as gitSha,
                         json_extract(json, '$.reasoning_effort') as reasoningEffort,
                         json_extract(json, '$.cli_version') as cliVersion,
                         json_extract(json, '$.source') as source
                  FROM threads`)
        .all();
    } catch {
      // Fall back to whatever columns the threads table actually has
      try {
        rows = db.prepare(`SELECT * FROM threads LIMIT 1`).all();
      } catch {
        return new Map();
      }
    }

    for (const row of rows) {
      if (!row.id) continue;
      const meta: CodexMetadata = {
        title: row.title || null,
        cwd: row.cwd || null,
        createdAt: row.createdAt ? parseDateTime(String(row.createdAt)) : null,
        updatedAt: row.updatedAt ? parseDateTime(String(row.updatedAt)) : null,
        rolloutPath: row.rolloutPath || null,
        firstUserMessage: row.firstUserMessage || null,
        model: row.model || null,
        tokensUsed: row.tokensUsed != null ? Number(row.tokensUsed) : null,
        gitBranch: row.gitBranch || null,
        gitSha: row.gitSha || null,
        reasoningEffort: row.reasoningEffort || null,
        cliVersion: row.cliVersion || null,
        source: row.source || null,
      };
      result.set(String(row.id), meta);
    }
    return result;
  } catch {
    return new Map();
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function loadIndexTitles(path: string): Map<string, string> {
  if (!existsSync(path)) return new Map();

  try {
    const content = readFileSync(path, 'utf-8');
    const result = new Map<string, string>();

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const obj = JSON.parse(trimmed);
        if (obj.id && typeof obj.id === 'string' && obj.thread_name && typeof obj.thread_name === 'string') {
          result.set(obj.id, obj.thread_name);
        }
      } catch {
        // Skip invalid JSON
      }
    }

    return result;
  } catch {
    return new Map();
  }
}

function extractId(path: string): string | null {
  const match = path.match(ID_RE);
  return match ? match[1] : null;
}

const DEFAULT_CODEX_HOME = join(require('os').homedir(), '.codex');
const DEFAULT_ROOTS = [join(DEFAULT_CODEX_HOME, 'sessions')];

export interface CodexAdapterOptions {
  roots?: string[];
  codexHome?: string;
}

export class CodexAdapter {
  readonly roots: string[];
  private threads: Map<string, CodexMetadata>;
  private indexTitles: Map<string, string>;

  constructor(options: CodexAdapterOptions = {}) {
    const home = options.codexHome || DEFAULT_CODEX_HOME;
    this.roots = options.roots || DEFAULT_ROOTS;
    this.threads = loadThreads(join(home, 'state_5.sqlite'));
    this.indexTitles = loadIndexTitles(join(home, 'session_index.jsonl'));
  }

  // ------------------------------------------------------------------
  // Discovery
  // ------------------------------------------------------------------

  discover(): SourceFile[] {
    const files: SourceFile[] = [];

    for (const root of this.roots) {
      if (!existsSync(root)) continue;

      const walk = (dir: string): void => {
        const entries = readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isDirectory()) {
            walk(join(dir, entry.name));
          } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            const path = join(dir, entry.name);
            try {
              const stat = statSync(path);
              files.push({
                provider: Provider.CODEX,
                path: normalizePath(path),
                mtimeNs: BigInt(Math.floor(stat.mtimeMs * 1_000_000)),
                sizeBytes: stat.size,
              });
            } catch {
              // Skip files that can't be read
            }
          }
        }
      };

      walk(root);
    }

    return files;
  }

  // ------------------------------------------------------------------
  // Parsing
  // ------------------------------------------------------------------

  parse(source: SourceFile): ParsedSession {
    try {
      return this.parseInner(source.path);
    } catch (exc) {
      return minimalRecord(Provider.CODEX, source.path, exc instanceof Error ? exc.message : String(exc));
    }
  }

  private parseInner(path: string): ParsedSession {
    const raw = readFileSync(path, 'utf-8');

    let providerSessionId = extractId(path) || 'unknown';
    let cwd: string | null = null;
    let createdAt: Date | null = null;
    let updatedAt: Date | null = null;
    const transcriptLines: string[] = [];
    let messageCount = 0;
    let firstUser: string | null = null;
    let lastUser: string | null = null;
    const pendingCalls = new Map<string, any>(); // call_id -> function_call payload
    let jsonlSummary: string | null = null;

    // Token / model accumulators from JSONL events
    let jsonlModel: string | null = null;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedInputTokens = 0;
    let totalReasoningTokens = 0;
    let totalTokensCount = 0;
    let jsonlGitBranch: string | null = null;
    let jsonlCliVersion: string | null = null;

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj: any;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }

      let timestamp: Date | null = null;
      const tsRaw = obj.timestamp;
      if (typeof tsRaw === 'string') {
        timestamp = parseDateTime(tsRaw);
      }

      const eventType = obj.type;

      // Look for summary in session_meta or turn_context payloads
      if (jsonlSummary === null) {
        const payload = obj.payload || {};
        const rawSummary = payload.summary;
        if (typeof rawSummary === 'string' && rawSummary.toLowerCase() !== 'none' && rawSummary) {
          jsonlSummary = rawSummary;
        }
      }

      if (eventType === 'session_meta') {
        const payload = obj.payload || {};
        if (payload.id) {
          providerSessionId = String(payload.id);
        }
        if (cwd === null && payload.cwd) {
          cwd = String(payload.cwd);
        }
        if (createdAt === null && payload.timestamp) {
          createdAt = parseDateTime(String(payload.timestamp));
        }
        if (jsonlCliVersion === null && payload.cli_version) {
          jsonlCliVersion = String(payload.cli_version);
        }
      } else if (eventType === 'turn_context') {
        const payload = obj.payload || {};
        if (jsonlModel === null && payload.model) {
          jsonlModel = String(payload.model);
        }
      } else if (eventType === 'event_msg') {
        const payload = obj.payload || {};
        const msgType = payload.type;

        if (msgType === 'token_count') {
          const info = payload.info || {};
          const totalUsage = info.total_token_usage || {};
          totalInputTokens += totalUsage.input_tokens || 0;
          totalOutputTokens += totalUsage.output_tokens || 0;
          totalCachedInputTokens += totalUsage.cached_input_tokens || 0;
          totalReasoningTokens += totalUsage.reasoning_output_tokens || 0;
          totalTokensCount += totalUsage.total_tokens || 0;
        }
      } else if (eventType === 'response_item') {
        const payload = obj.payload || {};
        const itemType = payload.type;
        const role = payload.role;

        if (itemType === 'message' && ['user', 'assistant'].includes(role)) {
          const text = extractText(payload);
          if (!text.trim()) continue;

          messageCount++;
          if (role === 'user') {
            if (firstUser === null) firstUser = text;
            lastUser = text;
          }
          updatedAt = timestamp || updatedAt;
          transcriptLines.push(formatTranscriptLine(role, timestamp, text));
        } else if (itemType === 'function_call') {
          const callId = payload.call_id || '';
          if (callId) {
            pendingCalls.set(callId, payload);
          }
          const name = payload.name || 'unknown';
          const args = payload.arguments || '';
          messageCount++;
          updatedAt = timestamp || updatedAt;
          transcriptLines.push(formatTranscriptLine('assistant', timestamp, formatFunctionCall(name, args, null)));
        } else if (itemType === 'function_call_output') {
          const callId = payload.call_id || '';
          const output = payload.output || '';
          const callPayload = pendingCalls.get(callId);
          messageCount++;
          updatedAt = timestamp || updatedAt;

          if (callPayload) {
            const name = callPayload.name || 'unknown';
            const args = callPayload.arguments || '';
            transcriptLines.push(formatTranscriptLine('assistant', timestamp, formatFunctionCall(name, args, output)));
            pendingCalls.delete(callId);
          } else if (output) {
            transcriptLines.push(formatTranscriptLine('assistant', timestamp, output));
          }
        }
      }
    }

    // Merge with SQLite / index metadata
    const meta = this.threads.get(providerSessionId) || {};

    let title: string | null = meta.title || this.indexTitles.get(providerSessionId) || firstUser || null;
    if (title) title = truncateForDisplay(title, 100);

    const summaryRaw = jsonlSummary || meta.firstUserMessage || firstUser || null;
    const summary = summaryRaw ? truncateForDisplay(summaryRaw, 180) : null;

    const effectiveCwd = cwd || meta.cwd || null;
    const repoRoot = effectiveCwd ? findRepoRoot(effectiveCwd) : null;
    const effectiveCreated = createdAt || meta.createdAt || null;
    const effectiveUpdated = updatedAt || meta.updatedAt || null;

    const previewRaw = lastUser || firstUser || summary;
    const preview = previewRaw ? previewFromText(previewRaw) : '(no preview available)';

    // Prefer JSONL-extracted values, fall back to SQLite metadata
    const model = jsonlModel || meta.model || null;
    const inputTokens = totalInputTokens || null;
    const outputTokens = totalOutputTokens || null;
    const cachedInputTokens = totalCachedInputTokens || null;
    const reasoningTokens = totalReasoningTokens || null;
    const totalTokens = totalTokensCount || meta.tokensUsed || null;
    const gitBranch = jsonlGitBranch || meta.gitBranch || null;
    const cliVersion = jsonlCliVersion || meta.cliVersion || null;

    const rawMetadataJson = JSON.stringify({
      lineCount: raw.split('\n').length,
      rolloutPath: meta.rolloutPath || null,
      sessionPath: normalizePath(path),
      model,
      modelProvider: meta.source,
      reasoningEffort: meta.reasoningEffort,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningTokens,
      totalTokens,
      gitBranch,
      gitSha: meta.gitSha,
      cliVersion,
    });

    const session: SessionRecord = {
      id: `codex:${providerSessionId}`,
      provider: Provider.CODEX,
      providerSessionId,
      title,
      summary,
      cwd: effectiveCwd,
      repoRoot,
      createdAt: effectiveCreated,
      updatedAt: effectiveUpdated,
      lastMessageAt: effectiveUpdated,
      previewText: preview,
      sourcePath: normalizePath(path),
      messageCount,
      model,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheCreationTokens: null,
      cacheCreation1hTokens: null,
      reasoningTokens,
      totalTokens,
      gitBranch,
      cliVersion,
      parseVersion: 'codex-v1',
      rawMetadataJson,
      parseWarning: null,
      discoverySource: 'jsonl+sqlite',
    };

    return {
      session,
      transcriptText: transcriptLines.join('\n\n'),
    };
  }
}
