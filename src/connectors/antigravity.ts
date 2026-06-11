/**
 * Antigravity adapter: discovers and parses Google Gemini Antigravity
 * session files (transcript.jsonl) from the brain directory.
 */

import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join, resolve, normalize, sep } from 'path';
import { Provider, SourceFile, ParsedSession, SessionRecord } from '../models';
import {
  findRepoRoot,
  formatTranscriptLine,
  minimalRecord,
  normalizePath,
  parseDateTime,
  previewFromText,
  truncateForDisplay,
} from '../utils';

const DEFAULT_ANTIGRAVITY_HOME = join(require('os').homedir(), '.gemini', 'antigravity');
const DEFAULT_ROOTS = [join(DEFAULT_ANTIGRAVITY_HOME, 'brain')];

const SKIP_DIRS = new Set(['.system_generated']);

const UUID_RE = /([0-9a-f]{8}-[0-9a-f\-]{36})/;

const TOOL_RESULT_TYPES = new Set(['LIST_DIRECTORY', 'GREP_SEARCH', 'VIEW_FILE', 'RUN_COMMAND', 'CODE_ACTION']);

function extractSessionId(path: string): string | null {
  const match = path.match(UUID_RE);
  return match ? match[1] : null;
}

function loadMetadataJsonl(brainDir: string): any {
  const metadataPath = join(brainDir, 'task.md.metadata.json');
  if (existsSync(metadataPath)) {
    try {
      const content = readFileSync(metadataPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      // Ignore parse errors
    }
  }
  return {};
}

function loadTranscript(brainDir: string): any[] {
  const transcriptPath = join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');
  if (!existsSync(transcriptPath)) return [];

  const entries: any[] = [];
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // Skip invalid JSON
      }
    }
  } catch {
    // Ignore read errors
  }
  return entries;
}

function extractUserInput(content: string): string | null {
  const match = content.match(/<USER_REQUEST>(.*?)<\/USER_REQUEST>/s);
  return match ? match[1].trim() : null;
}

function extractModelResponse(content: string): string {
  if (content.includes('<USER_REQUEST>')) return '';
  return content.trim();
}

function summarizeToolArgs(name: string, args: any): string {
  if (name === 'run_command') {
    const cmd = String(args.Command || args.command || '').trim();
    return cmd.length > 120 ? cmd.substring(0, 117) + '...' : cmd;
  }
  if (name === 'list_dir') {
    return String(args.DirectoryPath || '').trim().replace(/^"|"$/g, '');
  }
  if (name === 'grep_search') {
    return String(args.Query || '').trim().replace(/^"|"$/g, '');
  }
  if (name === 'view_file') {
    return String(args.FilePath || args.file_path || '').trim().replace(/^"|"$/g, '');
  }

  // Fallback: first string value
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.trim()) {
      const s = v.trim().replace(/^"|"$/g, '');
      return s.length > 120 ? s.substring(0, 117) + '...' : s;
    }
  }
  return '';
}

function formatAntigravityToolCall(name: string, args: any): string {
  const target = summarizeToolArgs(name, args);
  return target ? `[tool: ${name}] ${target}` : `[tool: ${name}]`;
}

function formatToolResult(entryType: string, content: string): string {
  // Strip leading timestamp lines
  const lines = content.trim().split('\n');
  const filtered: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Created At:') || trimmed.startsWith('Completed At:')) {
      continue;
    }
    filtered.push(line);
  }

  let body = filtered.join('\n').trim();
  if (!body) body = '(empty)';

  const toolName = entryType.toLowerCase();
  if (body.length > 1000) {
    body = body.substring(0, 997) + '...';
  }

  return `[tool result: ${toolName}]\n  => ${body}`;
}

export interface AntigravityAdapterOptions {
  roots?: string[];
}

export class AntigravityAdapter {
  readonly roots: string[];

  constructor(options: AntigravityAdapterOptions = {}) {
    this.roots = options.roots || DEFAULT_ROOTS;
  }

  // ------------------------------------------------------------------
  // Discovery
  // ------------------------------------------------------------------

  discover(): SourceFile[] {
    const files: SourceFile[] = [];

    for (const root of this.roots) {
      if (!existsSync(root)) continue;

      const entries = readdirSync(root, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const transcriptPath = join(root, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (!existsSync(transcriptPath)) continue;

        try {
          const stat = statSync(transcriptPath);
          files.push({
            provider: Provider.ANTIGRAVITY,
            path: normalizePath(join(root, entry.name)),
            mtimeNs: BigInt(Math.floor(stat.mtimeMs * 1_000_000)),
            sizeBytes: stat.size,
          });
        } catch {
          // Skip entries that can't be read
        }
      }
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
      return minimalRecord(Provider.ANTIGRAVITY, source.path, exc instanceof Error ? exc.message : String(exc));
    }
  }

  private parseInner(brainDir: string): ParsedSession {
    const providerSessionId = extractSessionId(brainDir) || brainDir.split('/').pop() || 'unknown';
    const metadata = loadMetadataJsonl(brainDir);
    const transcriptEntries = loadTranscript(brainDir);

    if (transcriptEntries.length === 0) {
      return minimalRecord(Provider.ANTIGRAVITY, brainDir, 'no transcript.jsonl found');
    }

    // Parse timestamps and messages
    const transcriptLines: string[] = [];
    let firstUser: string | null = null;
    let lastUser: string | null = null;
    let createdAt: Date | null = null;
    let updatedAt: Date | null = null;
    let messageCount = 0;

    for (const entry of transcriptEntries) {
      const entryType = entry.type || '';
      const content = entry.content || '';
      const tsStr = entry.created_at || '';
      const timestamp = tsStr ? parseDateTime(tsStr) : null;

      if (entryType === 'USER_INPUT') {
        const userText = extractUserInput(content);
        if (userText) {
          if (firstUser === null) firstUser = userText;
          lastUser = userText;
          if (createdAt === null) createdAt = timestamp;
          updatedAt = timestamp || updatedAt;
          messageCount++;
          transcriptLines.push(formatTranscriptLine('user', timestamp, userText));
        }
      } else if (entryType === 'PLANNER_RESPONSE' || entryType === 'MODEL_RESPONSE') {
        const text = extractModelResponse(content);
        const toolCalls = entry.tool_calls || [];
        const partsOut: string[] = [];

        if (text && text.trim()) {
          partsOut.push(text);
        }

        for (const tc of toolCalls) {
          const tcName = tc.name || 'unknown';
          const tcArgs = tc.args || {};
          partsOut.push(formatAntigravityToolCall(tcName, tcArgs));
        }

        const combined = partsOut.join('\n');
        if (combined.trim()) {
          if (createdAt === null) createdAt = timestamp;
          updatedAt = timestamp || updatedAt;
          messageCount++;
          transcriptLines.push(formatTranscriptLine('assistant', timestamp, combined));
        }
      } else if (TOOL_RESULT_TYPES.has(entryType)) {
        const resultText = formatToolResult(entryType, content);
        if (createdAt === null) createdAt = timestamp;
        updatedAt = timestamp || updatedAt;
        messageCount++;
        transcriptLines.push(formatTranscriptLine('assistant', timestamp, resultText));
      }
    }

    // Derive title from metadata or first user message
    const titleRaw = metadata.title || firstUser;
    const title = titleRaw ? truncateForDisplay(titleRaw, 100) : null;

    const summaryRaw = metadata.summary || firstUser;
    const summary = summaryRaw ? truncateForDisplay(summaryRaw, 180) : null;

    // Try to extract cwd from metadata
    const cwd = metadata.cwd || metadata.working_directory || null;
    const repoRoot = cwd ? findRepoRoot(cwd) : null;

    const previewRaw = lastUser || firstUser;
    const preview = previewRaw ? previewFromText(previewRaw) : '(no preview available)';

    const rawMetadataJson = JSON.stringify({
      sessionPath: normalizePath(brainDir),
      transcriptEntries: transcriptEntries.length,
      hasMetadataJson: Boolean(metadata && Object.keys(metadata).length > 0),
    });

    const session: SessionRecord = {
      id: `antigravity:${providerSessionId}`,
      provider: Provider.ANTIGRAVITY,
      providerSessionId,
      title,
      summary,
      cwd,
      repoRoot,
      createdAt,
      updatedAt,
      lastMessageAt: updatedAt,
      previewText: preview,
      sourcePath: normalizePath(brainDir),
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
      parseVersion: 'antigravity-v1',
      rawMetadataJson,
      parseWarning: null,
      discoverySource: 'brain/transcript.jsonl',
    };

    return {
      session,
      transcriptText: transcriptLines.join('\n\n'),
    };
  }
}
