import {
  HandoffOutputArtifact,
  HandoffOptions,
  HandoffPacket,
  HandoffSummary,
  HandoffTarget,
  TranscriptMessage,
  TranscriptToolOutput,
} from "./models";
import { readTranscript } from "./transcript";
import { buildHandoffSummary } from "./handoffSummary";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

export const HANDOFF_TARGETS: HandoffTarget[] = ["claude", "codex"];
export const MAX_HANDOFF_MESSAGES = 100;

export function isHandoffTarget(value: unknown): value is HandoffTarget {
  return value === "claude" || value === "codex";
}

export function defaultHandoffDir(target: HandoffTarget, sessionId: string): string {
  const agentDir = target === "codex" ? ".codex" : ".claude";
  return join(homedir(), agentDir, "handoffs", "rewind", safePathSegment(sessionId));
}

export function defaultHandoffArtifactDir(dataDir: string, sessionId: string): string {
  return join(resolve(dataDir), "handoffs", safePathSegment(sessionId));
}

export function buildHandoffPacket(
  session: any,
  options: HandoffOptions,
): HandoffPacket {
  const messageLimit = resolveMessageLimit(options.messages);
  const handoffDir = options.handoffDir ?? options.artifactDir ?? null;
  const resolvedHandoffDir = handoffDir ? resolve(handoffDir) : null;
  const handoffPath = resolvedHandoffDir ? join(resolvedHandoffDir, "HANDOFF.md") : null;
  const manifestPath = resolvedHandoffDir ? join(resolvedHandoffDir, "manifest.json") : null;
  const allMessages = readTranscript(session.source_path, session.provider, {
    includeToolOutputs: Boolean(resolvedHandoffDir),
  });
  const hasTranscriptError =
    allMessages.length > 0 && allMessages.every((message) => message.role === "error");
  const recentMessages =
    hasTranscriptError
      ? []
      : messageLimit === null
        ? allMessages
        : messageLimit === 0
          ? []
          : allMessages.slice(-messageLimit);
  const outputArtifacts = resolvedHandoffDir
    ? writeToolOutputArtifacts(resolvedHandoffDir, session, allMessages)
    : [];
  const summary = buildHandoffSummary(allMessages, outputArtifacts);
  const markdown = renderMarkdown(
    session,
    options.target,
    summary,
    recentMessages,
    outputArtifacts,
    resolvedHandoffDir,
    handoffPath,
    hasTranscriptError ? allMessages[0]?.text || "transcript unreadable" : null,
    allMessages.length,
  );
  if (resolvedHandoffDir && handoffPath && manifestPath) {
    writeHandoffBundle(resolvedHandoffDir, handoffPath, manifestPath, markdown, {
      target: options.target,
      session_id: field(session.id),
      provider: field(session.provider),
      provider_session_id: field(session.provider_session_id),
      handoff_path: handoffPath,
      output_dir: join(resolvedHandoffDir, "tool-outputs"),
      summary,
      output_artifacts: outputArtifacts,
    });
  }

  return {
    target: options.target,
    markdown,
    included_messages: recentMessages.length,
    summary,
    handoff_dir: resolvedHandoffDir,
    handoff_path: handoffPath,
    manifest_path: manifestPath,
    output_artifacts: outputArtifacts,
  };
}

export function clampMessages(value: number): number {
  if (!Number.isFinite(value)) return MAX_HANDOFF_MESSAGES;
  return Math.max(0, Math.min(MAX_HANDOFF_MESSAGES, Math.floor(value)));
}

function resolveMessageLimit(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return clampMessages(value);
}

function renderMarkdown(
  session: any,
  target: HandoffTarget,
  summary: HandoffSummary,
  messages: TranscriptMessage[],
  outputArtifacts: HandoffOutputArtifact[],
  handoffDir: string | null,
  handoffPath: string | null,
  transcriptWarning: string | null,
  readableMessageCount: number,
): string {
  const lines: string[] = [];
  const title = session.title || session.summary || "Untitled session";

  lines.push(`# Handoff: ${title}`);
  lines.push("");
  renderHandoffBanner(lines, session, target, handoffDir, handoffPath, outputArtifacts);
  lines.push("");
  lines.push("## Critical Summary");
  lines.push("_Generated deterministically from transcript/tool logs. No LLM was used._");
  renderSummaryList(lines, "User Request", summary.user_requests);
  renderSummaryList(lines, "What Changed", summary.actions_taken);
  renderSummaryList(lines, "Files Touched", summary.files_touched, true);
  renderSummaryList(lines, "Commands Run", summary.commands_run, true);
  renderSummaryList(lines, "Validation", summary.validations);
  renderSummaryList(lines, "Errors", summary.notable_errors);
  renderSummaryList(lines, "Risks / Notes", summary.remaining_notes);
  lines.push("");
  lines.push("## Source Session");
  lines.push(`- Source provider: ${field(session.provider)}`);
  lines.push(`- Rewind session id: ${field(session.id)}`);
  lines.push(`- Provider session id: ${field(session.provider_session_id)}`);
  lines.push(`- CWD: ${field(session.cwd)}`);
  lines.push(`- Repo: ${field(session.repo_root)}`);
  lines.push(`- Branch: ${field(session.git_branch)}`);
  lines.push(`- Created: ${field(session.session_created_at)}`);
  lines.push(`- Last message: ${field(session.session_last_message_at)}`);
  lines.push(`- Indexed messages: ${field(session.message_count)}`);
  lines.push(`- Model: ${field(session.model)}`);
  lines.push("");
  lines.push("## Stored Summary");
  lines.push(session.summary || session.title || "_No stored summary or title._");
  lines.push("");
  lines.push("## Critical Handoff Notes");
  lines.push("- Recent transcript entries include truncated tool output previews only.");
  if (handoffDir) {
    lines.push(`- Handoff directory: \`${handoffDir}\``);
    if (handoffPath) lines.push(`- Entry document: \`${handoffPath}\``);
    lines.push(`- Search the full bundle with: \`rg \"pattern\" ${shellQuote(handoffDir)}\``);
    if (outputArtifacts.length > 0) {
      lines.push("- Full raw tool outputs are stored as `.txt` files under `tool-outputs/`.");
    } else {
      lines.push("- No full tool outputs were found for this session.");
    }
  } else {
    lines.push("- No handoff directory was configured for full tool outputs.");
  }
  lines.push("");
  lines.push("## Tool Output Index");
  if (outputArtifacts.length === 0) {
    lines.push("_No tool output artifacts were written._");
  } else {
    for (const artifact of outputArtifacts) {
      lines.push(
        `- \`${artifact.id}\` -> \`${artifact.relative_path}\` (${artifact.bytes} bytes, tool: ${artifact.tool_name}, message: ${artifact.message_index}${artifact.ts ? `, ts: ${artifact.ts}` : ""})`,
      );
    }
  }
  lines.push("");
  lines.push("## Recent Transcript");
  if (messages.length === readableMessageCount) {
    lines.push(`Showing all ${readableMessageCount} readable message${readableMessageCount === 1 ? "" : "s"}.`);
  } else {
    lines.push(
      `Showing ${messages.length} of ${readableMessageCount} readable message${readableMessageCount === 1 ? "" : "s"}.`,
    );
  }

  if (transcriptWarning) {
    lines.push("");
    lines.push(`> Transcript warning: ${transcriptWarning}`);
  } else if (messages.length === 0) {
    lines.push("");
    lines.push("_No readable transcript messages were available._");
  } else {
    messages.forEach((message, index) => {
      lines.push("");
      lines.push(`### ${index + 1}. ${message.role}${message.ts ? ` (${message.ts})` : ""}`);
      lines.push("");
      lines.push(fence(message.text));
    });
  }

  lines.push("");
  lines.push("## Continue From This Context");
  lines.push(targetPrompt(target));
  lines.push("");

  return lines.join("\n");
}

function renderHandoffBanner(
  lines: string[],
  session: any,
  target: HandoffTarget,
  handoffDir: string | null,
  handoffPath: string | null,
  outputArtifacts: HandoffOutputArtifact[],
): void {
  const source = field(session.provider);
  lines.push("## Handoff Notice");
  lines.push(
    `This is an automated Rewind handoff from ${source} to ${target}. Use this document as the entry point, then inspect the referenced files as needed before editing.`,
  );
  lines.push("");
  lines.push("- Summary and transcript excerpts are in this `HANDOFF.md` file.");
  if (handoffDir) {
    lines.push(`- Handoff bundle directory: \`${handoffDir}\``);
    if (handoffPath) lines.push(`- Entry document: \`${handoffPath}\``);
    lines.push(`- Manifest: \`${join(handoffDir, "manifest.json")}\``);
    lines.push(`- Full tool outputs: \`${join(handoffDir, "tool-outputs")}\``);
    lines.push(`- Search everything with: \`rg \"pattern\" ${shellQuote(handoffDir)}\``);
  } else {
    lines.push("- No handoff bundle directory was written for this preview.");
  }
  lines.push(`- Indexed tool output files: ${outputArtifacts.length}`);
}

function renderSummaryList(
  lines: string[],
  title: string,
  items: string[],
  monospace = false,
): void {
  lines.push("");
  lines.push(`### ${title}`);
  if (items.length === 0) {
    lines.push("- _No evidence found._");
    return;
  }

  for (const item of items) {
    lines.push(`- ${monospace ? `\`${item.replace(/`/g, "\\`")}\`` : item}`);
  }
}

function writeToolOutputArtifacts(
  handoffDir: string,
  session: any,
  messages: TranscriptMessage[],
): HandoffOutputArtifact[] {
  const resolvedDir = resolve(handoffDir);
  const outputDir = join(resolvedDir, "tool-outputs");
  mkdirSync(outputDir, { recursive: true });
  removePreviousArtifacts(outputDir);

  const artifacts: HandoffOutputArtifact[] = [];
  messages.forEach((message, messageIdx) => {
    for (const toolOutput of message.toolOutputs || []) {
      const filename = `${toolOutput.id}.txt`;
      const relativePath = join("tool-outputs", filename);
      const path = join(resolvedDir, relativePath);
      writeFileSync(path, renderToolOutputArtifact(session, messageIdx + 1, toolOutput), "utf-8");
      artifacts.push({
        id: toolOutput.id,
        tool_name: toolOutput.toolName,
        path,
        relative_path: relativePath,
        bytes: toolOutput.bytes,
        message_index: messageIdx + 1,
        ts: toolOutput.ts,
      });
    }
  });

  return artifacts;
}

function writeHandoffBundle(
  handoffDir: string,
  handoffPath: string,
  manifestPath: string,
  markdown: string,
  manifest: Record<string, unknown>,
): void {
  mkdirSync(handoffDir, { recursive: true });
  writeFileSync(handoffPath, markdown, "utf-8");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

function renderToolOutputArtifact(
  session: any,
  messageIndex: number,
  toolOutput: TranscriptToolOutput,
): string {
  const header = [
    "# Rewind Tool Output Artifact",
    `session_id: ${field(session.id)}`,
    `provider: ${field(session.provider)}`,
    `provider_session_id: ${field(session.provider_session_id)}`,
    `tool_output_id: ${toolOutput.id}`,
    `tool_name: ${toolOutput.toolName}`,
    `message_index: ${messageIndex}`,
    `timestamp: ${field(toolOutput.ts)}`,
    `source_path: ${field(session.source_path)}`,
    "",
    "--- output ---",
    "",
  ];
  return header.join("\n") + toolOutput.output + "\n";
}

function removePreviousArtifacts(dir: string): void {
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir)) {
    if (/^tool-output-\d{4}-.*\.txt$/.test(entry) || entry === "manifest.json") {
      unlinkSync(join(dir, entry));
    }
  }
}

function targetPrompt(target: HandoffTarget): string {
  if (target === "claude") {
    return "You are Claude. Continue from this Rewind handoff packet. Respect the source repo, current branch, stored summary, and recent transcript. Ask only if required information is missing.";
  }

  return "You are Codex. Continue from this Rewind handoff packet. Use the source repo, current branch, stored summary, and recent transcript as context. Inspect the workspace before editing.";
}

function field(value: unknown): string {
  if (value === null || value === undefined || value === "") return "_unknown_";
  return String(value);
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "session";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function fence(value: string): string {
  const fenceMark = value.includes("```") ? "````" : "```";
  return `${fenceMark}\n${value.trim()}\n${fenceMark}`;
}
