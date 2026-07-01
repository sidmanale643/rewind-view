import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import {
  TranscriptMessage,
  TranscriptToolCall,
  TranscriptToolOutput,
} from "./models";

type ToolOutputSequence = { value: number };
type ReadTranscriptOptions = { includeToolOutputs?: boolean };

export function readTranscript(
  sourcePath: string,
  provider: string,
  options: ReadTranscriptOptions = {},
): TranscriptMessage[] {
  if (provider === "opencode") {
    return readOpenCodeTranscript(sourcePath, options);
  }

  if (provider === "antigravity") {
    sourcePath = resolveAntigravityTranscriptPath(sourcePath);
  }

  if (!existsSync(sourcePath)) {
    return [{ role: "error", text: `file not found: ${sourcePath}`, ts: null }];
  }
  if (!isRegularFile(sourcePath)) {
    return [{ role: "error", text: `not a file: ${sourcePath}`, ts: null }];
  }

  try {
    const content = readFileSync(sourcePath, "utf-8");
    const messages: TranscriptMessage[] = [];
    const pendingTools = new Map<string, any>();
    const pendingCodexCalls = new Map<string, any>();
    const toolOutputSeq: ToolOutputSequence = { value: 0 };

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj: any;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }

      let timestamp: string | null = null;
      const tsRaw = obj.timestamp;
      if (typeof tsRaw === "string") {
        try {
          timestamp = new Date(tsRaw).toISOString();
        } catch {
          // Ignore invalid timestamps from provider logs.
        }
      }

      if (provider === "codex") {
        readCodexEvent(
          obj,
          timestamp,
          messages,
          pendingCodexCalls,
          toolOutputSeq,
          options.includeToolOutputs === true,
        );
      } else if (provider === "antigravity") {
        readAntigravityEvent(
          obj,
          messages,
          toolOutputSeq,
          options.includeToolOutputs === true,
        );
      } else {
        readClaudeLikeEvent(
          obj,
          timestamp,
          messages,
          pendingTools,
          toolOutputSeq,
          options.includeToolOutputs === true,
        );
      }
    }

    return messages;
  } catch (exc) {
    return [
      {
        role: "error",
        text: exc instanceof Error ? exc.message : String(exc),
        ts: null,
      },
    ];
  }
}

function resolveAntigravityTranscriptPath(sourcePath: string): string {
  if (sourcePath.endsWith("transcript.jsonl")) return sourcePath;
  return join(sourcePath, ".system_generated", "logs", "transcript.jsonl");
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readOpenCodeTranscript(
  sourcePath: string,
  options: ReadTranscriptOptions,
): TranscriptMessage[] {
  const dbPath = sourcePath.split("?session=")[0];
  const sessionId = sourcePath.includes("session=")
    ? sourcePath.split("session=")[1]
    : "";

  if (!existsSync(dbPath)) {
    return [{ role: "error", text: `file not found: ${dbPath}`, ts: null }];
  }

  if (!sessionId) {
    return [{ role: "error", text: "no session id in source path", ts: null }];
  }

  let Database: any;
  try {
    Database = require("better-sqlite3");
  } catch {
    return [{ role: "error", text: "better-sqlite3 not available", ts: null }];
  }

  let db: any;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const toolOutputSeq: ToolOutputSequence = { value: 0 };

    const messages = db
      .prepare(
        "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC",
      )
      .all(sessionId);

    const parts = db
      .prepare(
        "SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC",
      )
      .all(sessionId);

    const partsByMsg = new Map<string, any[]>();
    for (const part of parts) {
      const list = partsByMsg.get(part.message_id) || [];
      list.push(part);
      partsByMsg.set(part.message_id, list);
    }

    const result: TranscriptMessage[] = [];
    for (const msg of messages) {
      let msgData: any;
      try {
        msgData = JSON.parse(msg.data);
      } catch {
        continue;
      }

      const role = msgData.role;
      if (role !== "user" && role !== "assistant") continue;

      const msgParts = partsByMsg.get(msg.id) || [];
      const texts: string[] = [];
      const toolCalls: TranscriptToolCall[] = [];
      const toolOutputs: TranscriptToolOutput[] = [];

      for (const part of msgParts) {
        let pData: any;
        try {
          pData = JSON.parse(part.data);
        } catch {
          continue;
        }

        if (pData.type === "text") {
          const text = pData.text || "";
          if (text.trim()) texts.push(text.trim());
        } else if (pData.type === "tool") {
          const formatted = formatOpenCodeToolPart(
            pData,
            timestampFromUnix(msg.time_created),
            toolOutputSeq,
            options.includeToolOutputs === true,
          );
          texts.push(formatted.text);
          if (formatted.toolCall) toolCalls.push(formatted.toolCall);
          if (formatted.toolOutput) toolOutputs.push(formatted.toolOutput);
        }
      }

      const text = texts.join("\n");
      if (!text.trim()) continue;

      let ts: string | null = null;
      if (msg.time_created) {
        try {
          ts = new Date(Math.floor(msg.time_created / 1000)).toISOString();
        } catch {
          // Ignore invalid timestamps from provider logs.
        }
      }

      result.push({
        role,
        text: text.trim(),
        ts,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(toolOutputs.length > 0 ? { toolOutputs } : {}),
      });
    }

    return result;
  } catch (exc) {
    return [
      {
        role: "error",
        text: exc instanceof Error ? exc.message : String(exc),
        ts: null,
      },
    ];
  } finally {
    if (db) db.close();
  }
}

function readCodexEvent(
  obj: any,
  timestamp: string | null,
  messages: TranscriptMessage[],
  pendingCalls: Map<string, any>,
  toolOutputSeq: ToolOutputSequence,
  includeToolOutputs: boolean,
): void {
  const eventType = obj.type;
  const payload = obj.payload || {};

  if (eventType === "response_item") {
    const itemType = payload.type;
    const role = payload.role;

    if (
      itemType === "message" &&
      ["user", "assistant", "developer"].includes(role)
    ) {
      const text = extractText(payload);
      if (!text.trim()) return;

      messages.push({
        role: role === "developer" ? "system" : role,
        text: text.trim(),
        ts: timestamp,
      });
    } else if (itemType === "function_call") {
      const callId = payload.call_id || "";
      if (callId) pendingCalls.set(callId, payload);
      const toolCall = createToolCall(
        callId || undefined,
        payload.name || "unknown",
        payload.arguments || "{}",
        timestamp,
      );

      messages.push({
        role: "assistant",
        text: formatFunctionCall(payload.name || "unknown", payload.arguments || "{}", null),
        ts: timestamp,
        toolCalls: [toolCall],
      });
    } else if (itemType === "function_call_output") {
      const callId = payload.call_id || "";
      const callPayload = callId ? pendingCalls.get(callId) : null;
      const toolName = callPayload?.name || "unknown";
      const args = callPayload?.arguments || "{}";
      const output = payload.output || "";
      const toolOutput = output && includeToolOutputs
        ? createToolOutput(toolOutputSeq, toolName, output, timestamp)
        : null;

      messages.push({
        role: "assistant",
        text: formatFunctionCall(
          toolName,
          args,
          output ? (toolOutput ? toolOutput.preview : output) : null,
          toolOutput?.id,
        ),
        ts: timestamp,
        ...(toolOutput ? { toolOutputs: [toolOutput] } : {}),
      });
      if (callId) pendingCalls.delete(callId);
    }
  } else if (eventType === "session_meta") {
    const systemText = payload.base_instructions?.text || "";
    if (systemText) {
      messages.push({ role: "system", text: systemText, ts: timestamp });
    }
  }
}

function readClaudeLikeEvent(
  obj: any,
  timestamp: string | null,
  messages: TranscriptMessage[],
  pendingTools: Map<string, any>,
  toolOutputSeq: ToolOutputSequence,
  includeToolOutputs: boolean,
): void {
  let role = obj.type;
  let text = "";
  const toolCalls: TranscriptToolCall[] = [];
  const toolOutputs: TranscriptToolOutput[] = [];

  if (obj.message && typeof obj.message === "object") {
    role = obj.message.role || role;
    const messageContent = obj.message.content;

    if (typeof messageContent === "string") {
      text = messageContent;
    } else if (Array.isArray(messageContent)) {
      const parts: string[] = [];

      for (const block of messageContent) {
        if (!block || typeof block !== "object") continue;

        const btype = block.type;

        if (btype === "text") {
          parts.push(block.text || "");
        } else if (btype === "tool_use") {
          pendingTools.set(block.id, block);
          toolCalls.push(createToolCall(block.id, block.name || "unknown", block.input || null, timestamp));
          parts.push(formatToolCall(block, null));
        } else if (btype === "tool_result") {
          const toolBlock = pendingTools.get(block.tool_use_id);
          const out = extractClaudeToolResult(block.content || "");

          if (toolBlock) {
            const toolOutput = out && includeToolOutputs
              ? createToolOutput(toolOutputSeq, toolBlock.name || "unknown", out, timestamp)
              : null;
            parts.push(
              formatToolCall(
                toolBlock,
                out ? (toolOutput ? toolOutput.preview : out) : null,
                toolOutput?.id,
              ),
            );
            if (toolOutput) toolOutputs.push(toolOutput);
            pendingTools.delete(block.tool_use_id);
          } else if (out) {
            const toolOutput = includeToolOutputs
              ? createToolOutput(toolOutputSeq, "unknown", out, timestamp)
              : null;
            parts.push(formatToolOutputOnly(toolOutput ? toolOutput.preview : out, toolOutput?.id));
            if (toolOutput) toolOutputs.push(toolOutput);
          }
        }
      }

      text = parts.join("\n");
    }
  } else if (typeof obj.content === "string") {
    text = obj.content;
  }

  if (role && ["user", "assistant"].includes(role) && text.trim()) {
    messages.push({
      role,
      text: text.trim(),
      ts: timestamp,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(toolOutputs.length > 0 ? { toolOutputs } : {}),
    });
  }
}

function readAntigravityEvent(
  obj: any,
  messages: TranscriptMessage[],
  toolOutputSeq: ToolOutputSequence,
  includeToolOutputs: boolean,
): void {
  const entryType = obj.type || "";
  const timestamp = typeof obj.created_at === "string" ? obj.created_at : null;
  const content = typeof obj.content === "string" ? obj.content : "";

  if (entryType === "USER_INPUT") {
    const text = extractAntigravityUserInput(content);
    if (text) messages.push({ role: "user", text, ts: timestamp });
    return;
  }

  if (entryType === "PLANNER_RESPONSE" || entryType === "MODEL_RESPONSE") {
    const parts: string[] = [];
    const text = content.includes("<USER_REQUEST>") ? "" : content.trim();
    const toolCalls: TranscriptToolCall[] = [];

    if (text) parts.push(text);
    for (const tc of obj.tool_calls || []) {
      const name = tc?.name || "unknown";
      const args = tc?.args || {};
      toolCalls.push(createToolCall(undefined, name, args, timestamp));
      parts.push(formatNamedToolCall(name, args, null));
    }

    if (parts.length > 0) {
      messages.push({
        role: "assistant",
        text: parts.join("\n").trim(),
        ts: timestamp,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
    }
    return;
  }

  if (["LIST_DIRECTORY", "GREP_SEARCH", "VIEW_FILE", "RUN_COMMAND", "CODE_ACTION"].includes(entryType)) {
    const output = stripAntigravityToolTimestamps(content);
    const toolName = entryType.toLowerCase();
    const toolOutput = output && includeToolOutputs
      ? createToolOutput(toolOutputSeq, toolName, output, timestamp)
      : null;

    messages.push({
      role: "assistant",
      text: formatToolOutputOnly(toolOutput ? toolOutput.preview : output || "(empty)", toolOutput?.id),
      ts: timestamp,
      ...(toolOutput ? { toolOutputs: [toolOutput] } : {}),
    });
  }
}

function extractAntigravityUserInput(content: string): string {
  const match = content.match(/<USER_REQUEST>(.*?)<\/USER_REQUEST>/s);
  return (match ? match[1] : content).trim();
}

function stripAntigravityToolTimestamps(content: string): string {
  return content
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("Created At:") && !trimmed.startsWith("Completed At:");
    })
    .join("\n")
    .trim();
}

function extractText(payload: any): string {
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

function extractClaudeToolResult(inner: any): string {
  if (typeof inner === "string") return inner;
  if (!Array.isArray(inner)) return "";

  let out = "";
  for (const sub of inner) {
    if (
      sub &&
      typeof sub === "object" &&
      ["text", "input_text", "output_text"].includes(sub.type)
    ) {
      out += sub.text || "";
    }
  }
  return out;
}

function formatOpenCodeToolPart(
  pData: any,
  timestamp: string | null,
  toolOutputSeq: ToolOutputSequence,
  includeToolOutputs: boolean,
): {
  text: string;
  toolCall: TranscriptToolCall;
  toolOutput: TranscriptToolOutput | null;
} {
  const name = pData.tool || "unknown";
  const state = pData.state || {};
  const inp = state.input || {};
  const output = state.output;
  const toolCall = createToolCall(undefined, name, inp, timestamp);
  const toolOutput =
    output !== undefined && output !== null && includeToolOutputs
      ? createToolOutput(toolOutputSeq, name, String(output), timestamp)
      : null;

  const lines = [`[tool: ${name}]`];
  if (typeof inp === "object" && inp !== null) {
    for (const [k, v] of Object.entries(inp)) {
      if (v === null) continue;
      const val = String(v).trim();
      lines.push(`  ${k}: ${truncate(val, 500)}`);
    }
  }
  if (output !== undefined && output !== null) {
    lines.push(`  => ${toolOutput ? toolOutput.preview : truncate(String(output).trim(), 1000)}`);
    if (toolOutput) lines.push(`  [full output: ${toolOutput.id}]`);
  }
  return { text: lines.join("\n"), toolCall, toolOutput };
}

function formatFunctionCall(
  name: string,
  argsStr: string,
  output: string | null,
  outputId?: string,
): string {
  const lines: string[] = [`[tool: ${name}]`];

  try {
    const args = JSON.parse(argsStr);
    if (typeof args === "object" && args !== null) {
      for (const [k, v] of Object.entries(args)) {
        if (v === null) continue;
        lines.push(`  ${k}: ${truncate(String(v).trim(), 500)}`);
      }
    }
  } catch {
    // Ignore malformed provider payloads.
  }

  if (output !== null && output !== undefined) {
    lines.push(`  => ${truncate(output.trim(), 1000)}`);
    if (outputId) lines.push(`  [full output: ${outputId}]`);
  }

  return lines.join("\n");
}

function formatToolCall(
  block: any,
  outputText: string | null,
  outputId?: string,
): string {
  const name = block.name || "unknown";
  const inp = block.input || {};
  const lines: string[] = [`[tool: ${name}]`];

  if (typeof inp === "object" && inp !== null) {
    for (const [k, v] of Object.entries(inp)) {
      if (v === null) continue;
      lines.push(`  ${k}: ${truncate(String(v).trim(), 500)}`);
    }
  }

  if (outputText !== null) {
    lines.push(`  => ${truncate(outputText.trim(), 1000)}`);
    if (outputId) lines.push(`  [full output: ${outputId}]`);
  }

  return lines.join("\n");
}

function formatNamedToolCall(
  name: string,
  args: Record<string, unknown>,
  outputText: string | null,
): string {
  return formatToolCall({ name, input: args }, outputText);
}

function formatToolOutputOnly(outputText: string, outputId?: string): string {
  const lines = [`[tool: unknown]`, `  => ${truncate(outputText.trim(), 1000)}`];
  if (outputId) lines.push(`  [full output: ${outputId}]`);
  return lines.join("\n");
}

function createToolCall(
  id: string | undefined,
  name: string,
  args: Record<string, unknown> | string | null,
  timestamp: string | null,
): TranscriptToolCall {
  return {
    ...(id ? { id } : {}),
    name,
    args: normalizeToolArgs(args),
    ts: timestamp,
  };
}

function normalizeToolArgs(
  args: Record<string, unknown> | string | null,
): Record<string, unknown> | string | null {
  if (args === null || args === undefined) return null;
  if (typeof args !== "string") return args;

  const trimmed = args.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Provider logs can contain non-JSON tool arguments.
  }
  return trimmed;
}

function createToolOutput(
  seq: ToolOutputSequence,
  toolName: string,
  output: string,
  timestamp: string | null,
): TranscriptToolOutput {
  const trimmed = output.trim();
  const id = `tool-output-${String(++seq.value).padStart(4, "0")}-${slug(toolName)}`;

  return {
    id,
    toolName,
    output: trimmed,
    preview: truncate(trimmed, 1000),
    bytes: Buffer.byteLength(trimmed, "utf8"),
    ts: timestamp,
  };
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "unknown";
}

function timestampFromUnix(value: unknown): string | null {
  if (!value) return null;
  try {
    return new Date(Math.floor(Number(value) / 1000)).toISOString();
  } catch {
    return null;
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.substring(0, max - 3) + "...";
}
