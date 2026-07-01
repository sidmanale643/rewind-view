/**
 * Rewind Session Viewer
 * Main entry point for the library.
 */

export { Provider, SourceFile, ParsedSession, SessionRecord, IndexResult, SearchHit, Action } from './models';
export { SessionStore } from './services/sessionStore';
export { buildHandoffPacket, defaultHandoffDir, defaultHandoffArtifactDir } from './handoff';
export { buildHandoffSummary } from './handoffSummary';
export { readTranscript } from './transcript';
export { ClaudeAdapter } from './connectors/claude';
export { CodexAdapter } from './connectors/codex';
export { OpenCodeAdapter } from './connectors/opencode';
export { AntigravityAdapter } from './connectors/antigravity';
export { CursorAdapter } from './connectors/cursor';
export { Indexer } from './indexer';

// Re-export utilities
export * from './utils';
