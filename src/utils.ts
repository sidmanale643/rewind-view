/**
 * Shared utility functions for all connectors.
 */

import { Provider, SessionRecord, ParsedSession } from "./models";
import { join, resolve, normalize, sep, dirname } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
export const DEFAULT_DATA_DIR = join(homedir(), ".rewind", "data");

export function getDataDir(): string {
  return DEFAULT_DATA_DIR;
}

export function getDbPath(): string {
  return join(DEFAULT_DATA_DIR, "rewind.sqlite");
}

export function parseDateTime(value: string): Date | null {
  if (!value) return null;
  const normalized = value.replace("Z", "+00:00");
  try {
    return new Date(normalized);
  } catch {
    return null;
  }
}

export function parseUnixSeconds(ts: number | null): Date | null {
  if (ts === null || ts === 0) return null;
  try {
    return new Date(ts * 1000);
  } catch {
    return null;
  }
}

export function normalizePath(path: string): string {
  return resolve(path).split(sep).join("/");
}

export function findRepoRoot(cwd: string): string | null {
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

  return null;
}

export function truncateForDisplay(text: string, maxChars: number): string {
  text = text.trim();
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars).trimEnd() + "…";
}

export function previewFromText(text: string): string {
  text = text.trim().replace(/\n/g, " ");
  return truncateForDisplay(text, 120);
}

export function formatTranscriptLine(
  role: string,
  ts: Date | null,
  text: string,
): string {
  const tsStr = ts ? ts.toISOString() : "unknown";
  return `[${tsStr}] ${role.toUpperCase()}: ${text}`;
}

export function extractText(payload: any): string {
  const content = payload.content || "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const btype = block.type;
        if (
          btype === "text" ||
          btype === "input_text" ||
          btype === "output_text"
        ) {
          texts.push(block.text || "");
        }
      }
    }
    return texts.join("\n");
  }
  return "";
}

export function minimalRecord(
  provider: Provider,
  path: string,
  error: string,
): ParsedSession {
  const stem = (path.split("/").pop() || "unknown").replace(/\.jsonl$/, "");
  const session: SessionRecord = {
    id: `${provider}:${stem}`,
    provider,
    providerSessionId: stem,
    title: null,
    summary: null,
    cwd: null,
    repoRoot: null,
    createdAt: null,
    updatedAt: null,
    lastMessageAt: null,
    previewText: `(parse error: ${error})`,
    sourcePath: normalizePath(path),
    messageCount: null,
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
    parseVersion: `${provider}-v1`,
    rawMetadataJson: null,
    parseWarning: error,
    discoverySource: "jsonl",
  };

  return {
    session,
    transcriptText: "",
  };
}
