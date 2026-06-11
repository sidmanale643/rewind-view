/**
 * Shared data models for all connectors.
 */

export enum Provider {
  CLAUDE = "claude",
  CODEX = "codex",
  CURSOR = "cursor",
  ANTIGRAVITY = "antigravity",
  OPENCODE = "opencode",
}

export interface SourceFile {
  provider: Provider;
  path: string;
  mtimeNs: bigint;
  sizeBytes: number;
}

export interface SessionRecord {
  id: string;
  provider: Provider;
  providerSessionId: string;
  title: string | null;
  summary: string | null;
  cwd: string | null;
  repoRoot: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  lastMessageAt: Date | null;
  previewText: string;
  sourcePath: string;
  messageCount: number | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheCreation1hTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  gitBranch: string | null;
  cliVersion: string | null;
  parseVersion: string;
  rawMetadataJson: string | null;
  parseWarning: string | null;
  discoverySource: string;
}

export interface ParsedSession {
  session: SessionRecord;
  transcriptText: string;
}

export interface IndexResult {
  provider: string;
  collection: string;
  discovered: number;
  indexed: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export interface SearchHit {
  id: string;
  score: number;
  provider: string;
  title: string | null;
  summary: string | null;
  cwd: string | null;
  lastMessageAt: string | null;
  sourcePath: string;
  resumeCommand: string | null;
  snippet?: string;
  model: string | null;
  totalTokens: number | null;
}

export interface Action {
  id?: number;
  sessionId: string;
  actionIndex: number;
  actionType: string;
  actionTarget?: string;
  actionInputJson?: string;
  timestamp?: string;
  agent: string;
}

export interface SessionRow {
  id: string;
  provider: string;
  provider_session_id: string;
  title: string | null;
  summary: string | null;
  cwd: string | null;
  repo_root: string | null;
  message_count: number | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_creation_1h_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  git_branch: string | null;
  cli_version: string | null;
  source_path: string;
  source_mtime_ns: bigint | null;
  source_size_bytes: number | null;
  content_hash: string;
  indexed_content_hash: string | null;
  status: string;
  vector_collection: string | null;
  vector_id: string | null;
  session_created_at: string | null;
  session_last_message_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  last_indexed_at: string | null;
  last_error: string | null;
  transcript_text: string | null;
}

export interface GrepResult {
  id: string;
  provider: string;
  provider_session_id: string;
  source_path: string;
  session_last_message_at: string | null;
  match_count: number;
  snippets: string[];
}
