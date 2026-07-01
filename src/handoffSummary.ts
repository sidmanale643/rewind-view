import {
  HandoffOutputArtifact,
  HandoffSummary,
  TranscriptMessage,
  TranscriptToolCall,
} from "./models";

const MAX_ITEMS = 12;

export function buildHandoffSummary(
  messages: TranscriptMessage[],
  artifacts: HandoffOutputArtifact[],
): HandoffSummary {
  const userRequests = collectUserRequests(messages);
  const toolCalls = messages.flatMap((message) => message.toolCalls || []);
  const commandsRun = collectCommands(toolCalls, messages);
  const filesTouched = collectFiles(messages, toolCalls, artifacts);
  const validations = collectValidations(messages, commandsRun);
  const notableErrors = collectNotableErrors(messages);
  const remainingNotes = collectRemainingNotes(messages);
  const actionsTaken = collectActions(messages, filesTouched, commandsRun);

  return {
    user_requests: userRequests,
    actions_taken: actionsTaken,
    files_touched: filesTouched,
    commands_run: commandsRun,
    validations,
    notable_errors: notableErrors,
    remaining_notes: remainingNotes,
  };
}

function collectUserRequests(messages: TranscriptMessage[]): string[] {
  const requests: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    if ((message.toolOutputs || []).length > 0) continue;
    if (message.text.trim().startsWith("[tool:")) continue;

    const cleaned = compact(message.text);
    if (!cleaned) continue;
    requests.push(cleaned);
  }

  return dedupe([...requests.slice(0, 2), ...requests.slice(-3)]).map((item) =>
    truncate(item, 240),
  );
}

function collectCommands(
  toolCalls: TranscriptToolCall[],
  messages: TranscriptMessage[],
): string[] {
  const commands: string[] = [];

  for (const call of toolCalls) {
    const cmd = commandFromToolCall(call);
    if (cmd) commands.push(cmd);
  }

  for (const message of messages) {
    for (const match of message.text.matchAll(/^\s*cmd:\s*(.+)$/gm)) {
      commands.push(match[1].trim());
    }
  }

  return dedupe(commands).slice(-MAX_ITEMS);
}

function collectFiles(
  messages: TranscriptMessage[],
  toolCalls: TranscriptToolCall[],
  artifacts: HandoffOutputArtifact[],
): string[] {
  const files: string[] = [];

  for (const call of toolCalls) {
    files.push(...filesFromToolCall(call));
  }

  for (const message of messages) {
    files.push(...filesFromText(message.text));
  }

  for (const artifact of artifacts) {
    files.push(artifact.relative_path || artifact.path);
  }

  return dedupe(files.filter(isLikelyProjectPath)).slice(0, MAX_ITEMS * 2);
}

function collectValidations(
  messages: TranscriptMessage[],
  commandsRun: string[],
): string[] {
  const validations: string[] = [];
  const validationCommands = commandsRun.filter((cmd) =>
    /\b(test|build|lint|typecheck|tsc|pytest|vitest|jest|smoke|verify)\b/i.test(cmd),
  );

  for (const cmd of validationCommands) {
    validations.push(`Ran \`${cmd}\``);
  }

  for (const message of messages) {
    for (const line of relevantLines(message.text)) {
      if (
        /\b(build|test|smoke|validation|typecheck|lint)\b/i.test(line) &&
        /\b(pass|passed|passes|success|confirmed|exit code 0)\b/i.test(line)
      ) {
        validations.push(truncate(line, 180));
      }
    }
  }

  return dedupe(validations).slice(-MAX_ITEMS);
}

function collectNotableErrors(messages: TranscriptMessage[]): string[] {
  const errors: string[] = [];
  for (const message of messages) {
    for (const line of relevantLines(message.text)) {
      if (/\b(error|failed|failure|exception|traceback|typeerror|syntaxerror)\b/i.test(line)) {
        if (/\b0 errors?\b/i.test(line)) continue;
        errors.push(truncate(line, 180));
      }
    }
  }

  return dedupe(errors).slice(-MAX_ITEMS);
}

function collectRemainingNotes(messages: TranscriptMessage[]): string[] {
  const notes: string[] = [];
  for (const message of messages) {
    for (const line of relevantLines(message.text)) {
      if (
        /\b(todo|follow[- ]?up|remaining|blocked|not able|couldn'?t|unable|risk|note:|pre-existing|dirty worktree)\b/i.test(
          line,
        )
      ) {
        notes.push(truncate(line, 180));
      }
    }
  }

  return dedupe(notes).slice(-MAX_ITEMS);
}

function collectActions(
  messages: TranscriptMessage[],
  filesTouched: string[],
  commandsRun: string[],
): string[] {
  const actions: string[] = [];

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const line of relevantLines(message.text)) {
      if (
        /\b(implemented|added|updated|changed|fixed|created|wired|connected|replaced|moved|exported|validated|confirmed)\b/i.test(
          line,
        )
      ) {
        actions.push(stripListMarker(line));
      }
    }
  }

  if (filesTouched.length > 0) {
    actions.push(`Observed edits or references across ${filesTouched.length} file path${filesTouched.length === 1 ? "" : "s"}.`);
  }

  if (commandsRun.length > 0) {
    actions.push(`Observed ${commandsRun.length} shell/tool command${commandsRun.length === 1 ? "" : "s"} run during the session.`);
  }

  return dedupe(actions.map((item) => truncate(item, 200))).slice(-MAX_ITEMS);
}

function commandFromToolCall(call: TranscriptToolCall): string | null {
  const name = call.name.toLowerCase();
  const args = call.args;
  if (!args || typeof args === "string") {
    return isCommandTool(name) && args ? args : null;
  }

  const cmd = pickString(args, ["cmd", "command", "script", "query"]);
  if (!cmd) return null;
  if (isCommandTool(name) || /\b(npm|pnpm|yarn|node|git|rg|sed|cat|python|uv|tsc)\b/.test(cmd)) {
    return cmd;
  }
  return null;
}

function isCommandTool(name: string): boolean {
  return /exec|shell|bash|terminal|command/.test(name);
}

function filesFromToolCall(call: TranscriptToolCall): string[] {
  const files: string[] = [];
  if (typeof call.args === "string") {
    files.push(...filesFromText(call.args));
    return files;
  }
  if (!call.args) return files;

  collectPathValues(call.args, files);
  const cmd = pickString(call.args, ["cmd", "command", "script"]);
  if (cmd) files.push(...filesFromText(cmd));
  return files;
}

function collectPathValues(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(...filesFromText(value));
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (/^(file|filename|filepath|path|target|source|destination|relative_path)$/i.test(key)) {
      if (typeof inner === "string") out.push(inner);
    } else if (typeof inner === "object") {
      collectPathValues(inner, out);
    }
  }
}

function filesFromText(text: string): string[] {
  const files: string[] = [];
  for (const match of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/gm)) {
    files.push(match[1].trim());
  }
  for (const match of text.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    files.push(match[1].trim(), match[2].trim());
  }
  for (const match of text.matchAll(/^\s*(?:M|A|D|R|C|\?\?)\s+([^\s].+)$/gm)) {
    files.push(match[1].trim());
  }
  for (const match of text.matchAll(/\[([^\]]+)\]\((\/[^):]+(?:\.[A-Za-z0-9]+)[^):]*)(?::\d+)?\)/g)) {
    files.push(match[2].trim());
  }
  for (const match of text.matchAll(/(?:^|[\s`'"])((?:\.{0,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)(?=$|[\s`'",):])/g)) {
    files.push(match[1].trim());
  }
  return files.map((file) => file.replace(/^["'`]+|["'`,.]+$/g, ""));
}

function relevantLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => stripListMarker(line.trim()))
    .filter((line) => line.length > 0 && !line.startsWith("[tool:"));
}

function pickString(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function stripListMarker(value: string): string {
  return value.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim();
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  const compacted = compact(value);
  if (compacted.length <= max) return compacted;
  return compacted.slice(0, max - 3).trimEnd() + "...";
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function isLikelyProjectPath(value: string): boolean {
  if (!value) return false;
  if (/^https?:\/\//i.test(value)) return false;
  if (/\bnode_modules\b/.test(value)) return false;
  if (!/[/.]/.test(value)) return false;
  return true;
}
