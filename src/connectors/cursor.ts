/**
 * Cursor Adapter
 * Discovers and parses Cursor agent-transcript .jsonl session files.
 */

import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { join, resolve, sep, dirname } from "path";
import { homedir } from "os";
import { Provider, SourceFile, ParsedSession, SessionRecord } from "../models";
import {
  normalizePath,
  findRepoRoot,
  truncateForDisplay,
  previewFromText,
  formatTranscriptLine,
  minimalRecord,
} from "../utils";

function defaultRoots(): string[] {
  const home = homedir();
  return [join(home, ".cursor", "projects")];
}

export const DEFAULT_ROOTS = defaultRoots();

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function substantiveText(text: string): boolean {
  return Boolean(text && text.trim());
}

/**
 * Extract the body of an XML-like tag from text.
 */
function extractTag(text: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  if (start === -1) return null;
  const innerStart = start + open.length;
  const end = text.indexOf(close, innerStart);
  if (end === -1) return null;
  return text.substring(innerStart, end).trim();
}

/**
 * Collect text content from a Cursor message.content value.
 * Handles both plain strings and arrays of content blocks.
 * Skips tool_use blocks (we only want text).
 */
function collectTextContent(content: any): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        const t = block.text.trim();
        if (t) parts.push(t);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Extract the display text from a Cursor message object.
 * Extracts <user_query> tags from user messages, otherwise returns raw text.
 * Skips tool_use payloads.
 */
function cursorMessageText(value: any): string {
  const message = value.message;
  if (!message || typeof message !== "object") return "";
  const text = collectTextContent(message.content);
  return extractTag(text, "user_query") || text;
}

/**
 * Infer the Cursor workspace from the file path.
 * Cursor stores transcripts under:
 *   <root>/<encoded-project>/agent-transcripts/<session-id>/<session-id>.jsonl
 * The encoded project directory name is derived from the OS path.
 */
function inferCursorWorkspace(filePath: string): string | null {
  const parts = filePath.split("/");
  let prev: string | null = null;
  for (const part of parts) {
    if (part === "agent-transcripts") {
      return prev ? decodeCursorProjectDir(prev) : null;
    }
    prev = part;
  }
  return null;
}

/**
 * Decode a Cursor-encoded project directory name back to a filesystem path.
 * Encoding: each "/" becomes "-", segments are joined with "-".
 * Example: "Users-adam-Desktop-myproject" -> "/Users/adam/Desktop/myproject"
 */
function decodeCursorProjectDir(encoded: string): string | null {
  if (encoded === "empty-window") return null;
  const parts = encoded.split("-");
  if (parts.length < 3 || parts[0] !== "Users") return null;

  // Try all possible partition points to find an existing path
  const suffixes = partitionSuffixes(parts.slice(1));
  for (const suffix of suffixes) {
    const candidate = "/" + ["Users", ...suffix].join("/");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Generate all possible ways to partition a list of dash-separated segments
 * back into path components (trying "-" as join character within each group).
 */
function partitionSuffixes(parts: string[]): string[][] {
  const results: string[][] = [];

  function walk(index: number, current: string[]): void {
    if (index >= parts.length) {
      results.push([...current]);
      return;
    }
    for (let end = index + 1; end <= parts.length; end++) {
      current.push(parts.slice(index, end).join("-"));
      walk(end, current);
      current.pop();
    }
  }

  walk(0, []);
  return results;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface CursorAdapterOptions {
  roots?: string[];
}

export class CursorAdapter {
  readonly roots: string[];

  constructor(options: CursorAdapterOptions = {}) {
    this.roots = options.roots || DEFAULT_ROOTS;
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
          } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            const path = join(dir, entry.name);

            // Must be inside an agent-transcripts directory
            if (!path.includes("/agent-transcripts/")) continue;

            // Skip subagent transcripts
            if (path.includes("/subagents/")) continue;

            try {
              const stat = statSync(path);
              files.push({
                provider: Provider.CURSOR,
                path: normalizePath(path),
                mtimeNs: BigInt(Math.floor(stat.mtimeMs * 1_000_000)),
                sizeBytes: stat.size,
              });
            } catch {
              // Skip files that can't be stat'd
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
      return minimalRecord(
        Provider.CURSOR,
        source.path,
        exc instanceof Error ? exc.message : String(exc),
      );
    }
  }

  private parseInner(filePath: string): ParsedSession {
    const raw = readFileSync(filePath, "utf-8");

    // Session ID comes from the filename stem (UUID)
    const stem = filePath.split("/").pop() || "unknown";
    const providerSessionId = stem.replace(/\.jsonl$/, "");
    const cwd = inferCursorWorkspace(normalizePath(filePath));
    let createdAt: Date | null = null;

    // Use file modification time as a fallback timestamp
    let updatedAt: Date | null = null;
    try {
      const stat = statSync(filePath);
      updatedAt = new Date(stat.mtimeMs);
    } catch {
      // ignore
    }

    const messages: { role: string; text: string }[] = [];
    const transcriptLines: string[] = [];

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let value: any;
      try {
        value = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const role = value.role;
      if (role !== "user" && role !== "assistant") continue;

      const text = cursorMessageText(value);
      if (!substantiveText(text)) continue;

      if (createdAt === null) createdAt = updatedAt;
      messages.push({ role, text });
      transcriptLines.push(formatTranscriptLine(role, updatedAt, text));
    }

    // Derive title and summary
    const firstUser = messages.find(
      (m) => m.role === "user" && substantiveText(m.text),
    );
    const lastUser = [...messages]
      .reverse()
      .find((m) => m.role === "user" && substantiveText(m.text));

    const titleSource = lastUser || firstUser;
    const title = titleSource
      ? truncateForDisplay(titleSource.text, 100)
      : null;
    const summary = firstUser
      ? truncateForDisplay(firstUser.text, 180)
      : null;
    const previewSource = lastUser || firstUser;
    const preview = previewSource
      ? previewFromText(previewSource.text)
      : "(no preview available)";

    const repoRoot = cwd ? findRepoRoot(cwd) : null;

    const rawMetadataJson = JSON.stringify({
      lineCount: raw.split("\n").length,
      sessionPath: normalizePath(filePath),
    });

    const session: SessionRecord = {
      id: `cursor:${providerSessionId}`,
      provider: Provider.CURSOR,
      providerSessionId,
      title,
      summary,
      cwd,
      repoRoot,
      createdAt,
      updatedAt,
      lastMessageAt: updatedAt,
      previewText: preview,
      sourcePath: normalizePath(filePath),
      messageCount: messages.length,
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
      parseVersion: "cursor-v1",
      rawMetadataJson,
      parseWarning: null,
      discoverySource: "jsonl",
    };

    return {
      session,
      transcriptText: transcriptLines.join("\n\n"),
    };
  }
}
