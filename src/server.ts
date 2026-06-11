/**
 * Rewind Web Server
 * Express server serving a single-page HTML interface for browsing
 * and searching sessions stored in the Rewind SQLite database.
 */

import express, { Request, Response, NextFunction } from "express";
import { join } from "path";
import { readFileSync, existsSync } from "fs";
import { SessionStore } from "./services/sessionStore";
import { PricingEngine } from "./pricing";
import { DEFAULT_DATA_DIR } from "./utils";

// Helper: Read OpenCode transcript from SQLite
function readOpenCodeTranscript(sourcePath: string): any[] {
  // sourcePath is "db_path?session=session_id"
  const dbPath = sourcePath.split("?session=")[0];
  const sessionId = sourcePath.includes("session=") ? sourcePath.split("session=")[1] : "";

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

    const messages = db
      .prepare(`SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC`)
      .all(sessionId);

    const parts = db
      .prepare(`SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC`)
      .all(sessionId);

    // Group parts by message_id
    const partsByMsg = new Map<string, any[]>();
    for (const part of parts) {
      const list = partsByMsg.get(part.message_id) || [];
      list.push(part);
      partsByMsg.set(part.message_id, list);
    }

    const result: any[] = [];
    for (const msg of messages) {
      let msgData: any;
      try { msgData = JSON.parse(msg.data); } catch { continue; }

      const role = msgData.role;
      if (role !== "user" && role !== "assistant") continue;

      const msgParts = partsByMsg.get(msg.id) || [];
      const texts: string[] = [];

      for (const part of msgParts) {
        let pData: any;
        try { pData = JSON.parse(part.data); } catch { continue; }

        if (pData.type === "text") {
          const text = pData.text || "";
          if (text.trim()) texts.push(text.trim());
        } else if (pData.type === "tool") {
          const name = pData.tool || "unknown";
          const state = pData.state || {};
          const inp = state.input || {};
          const output = state.output;

          const lines = [`[tool: ${name}]`];
          if (typeof inp === "object" && inp !== null) {
            for (const [k, v] of Object.entries(inp)) {
              if (v === null) continue;
              const val = String(v).trim();
              lines.push(`  ${k}: ${val.length > 500 ? val.substring(0, 497) + "..." : val}`);
            }
          }
          if (output !== undefined && output !== null) {
            const trimmed = String(output).trim();
            lines.push(`  => ${trimmed.length > 1000 ? trimmed.substring(0, 997) + "..." : trimmed}`);
          }
          texts.push(lines.join("\n"));
        }
      }

      const text = texts.join("\n");
      if (!text.trim()) continue;

      let ts: string | null = null;
      if (msg.time_created) {
        try { ts = new Date(Math.floor(msg.time_created / 1000)).toISOString(); } catch {}
      }

      result.push({ role, text: text.trim(), ts });
    }

    return result;
  } catch (exc) {
    return [{ role: "error", text: exc instanceof Error ? exc.message : String(exc), ts: null }];
  } finally {
    if (db) db.close();
  }
}

// Helper: Read transcript from source file
function readTranscript(sourcePath: string, provider: string): any[] {
  // OpenCode sessions are stored in SQLite, not as plain files
  if (provider === "opencode") {
    return readOpenCodeTranscript(sourcePath);
  }

  const path = sourcePath;

  if (!existsSync(path)) {
    return [{ role: "error", text: `file not found: ${path}`, ts: null }];
  }

  try {
    const content = readFileSync(path, "utf-8");
    const messages: any[] = [];
    const pendingTools = new Map<string, any>();

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
          // Invalid date
        }
      }

      if (provider === "codex") {
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
            if (!text.trim()) continue;

            const displayRole = role === "developer" ? "system" : role;
            messages.push({
              role: displayRole,
              text: text.trim(),
              ts: timestamp,
            });
          } else if (itemType === "function_call") {
            const name = payload.name || "unknown";
            const args = payload.arguments || "{}";
            messages.push({
              role: "assistant",
              text: formatFunctionCall(name, args, null),
              ts: timestamp,
            });
          } else if (itemType === "function_call_output") {
            const output = payload.output || "";
            messages.push({
              role: "assistant",
              text: formatFunctionCall("", "", output),
              ts: timestamp,
            });
          }
        } else if (eventType === "session_meta") {
          const baseInstructions = payload.base_instructions || {};
          const systemText = baseInstructions.text || "";
          if (systemText) {
            messages.push({ role: "system", text: systemText, ts: timestamp });
          }
        }
      } else {
        // Claude format
        let role = obj.type;
        let text = "";

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
                parts.push(formatToolCall(block, null));
              } else if (btype === "tool_result") {
                const toolBlock = pendingTools.get(block.tool_use_id);
                const inner = block.content || "";

                let out = "";
                if (typeof inner === "string") {
                  out = inner;
                } else if (Array.isArray(inner)) {
                  for (const sub of inner) {
                    if (
                      sub &&
                      typeof sub === "object" &&
                      ["text", "input_text", "output_text"].includes(sub.type)
                    ) {
                      out += sub.text || "";
                    }
                  }
                }

                if (toolBlock) {
                  parts.push(formatToolCall(toolBlock, out));
                  pendingTools.delete(block.tool_use_id);
                } else if (out) {
                  parts.push(out);
                }
              }
            }

            text = parts.join("\n");
          }
        } else if (typeof obj.content === "string") {
          text = obj.content;
        }

        if (role && ["user", "assistant"].includes(role) && text.trim()) {
          messages.push({ role, text: text.trim(), ts: timestamp });
        }
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

function formatFunctionCall(
  name: string,
  argsStr: string,
  output: string | null,
): string {
  const lines: string[] = [`[tool: ${name}]`];

  try {
    const args = JSON.parse(argsStr);
    if (typeof args === "object" && args !== null) {
      for (const [k, v] of Object.entries(args)) {
        if (v === null) continue;
        const val = String(v).trim();
        lines.push(
          `  ${k}: ${val.length > 500 ? val.substring(0, 497) + "..." : val}`,
        );
      }
    }
  } catch {
    // Ignore parse errors
  }

  if (output !== null && output !== undefined) {
    const trimmed = output.trim();
    lines.push(
      `  => ${trimmed.length > 1000 ? trimmed.substring(0, 997) + "..." : trimmed}`,
    );
  }

  return lines.join("\n");
}

function formatToolCall(block: any, outputText: string | null): string {
  const name = block.name || "unknown";
  const inp = block.input || {};
  const lines: string[] = [`[tool: ${name}]`];

  if (typeof inp === "object" && inp !== null) {
    for (const [k, v] of Object.entries(inp)) {
      if (v === null) continue;
      const val = String(v).trim();
      lines.push(
        `  ${k}: ${val.length > 500 ? val.substring(0, 497) + "..." : val}`,
      );
    }
  }

  if (outputText !== null) {
    const outStr = outputText.trim();
    lines.push(
      `  => ${outStr.length > 1000 ? outStr.substring(0, 997) + "..." : outStr}`,
    );
  }

  return lines.join("\n");
}

export function startServer(options?: {
  port?: number | string;
  dataDir?: string;
}): Promise<{ port: number; close: () => void }> {
  const port = options?.port ?? process.env.PORT ?? 3000;
  const dataDir = options?.dataDir ?? process.env.DATA_DIR ?? DEFAULT_DATA_DIR;

  const app = express();

  let store: SessionStore | null = null;

  function getStore(): SessionStore {
    if (!store) {
      store = new SessionStore(dataDir);
    }
    return store;
  }

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Serve static files (the HTML interface)
  app.get("/ui", (req: Request, res: Response) => {
    const htmlPath = join(__dirname, "index.html");
    if (!existsSync(htmlPath)) {
      return res.status(404).send("HTML interface not found");
    }
    res.send(readFileSync(htmlPath, "utf-8"));
  });

  // Also serve root path
  app.get("/", (req: Request, res: Response) => {
    res.redirect("/ui");
  });

  // API: Stats
  app.get("/api/stats", async (req: Request, res: Response) => {
    try {
      const stats = await getStore().getStats();
      res.json(stats);
    } catch (exc) {
      res
        .status(500)
        .json({ error: exc instanceof Error ? exc.message : String(exc) });
    }
  });

  // API: List sessions
  app.get("/api/sessions", (req: Request, res: Response) => {
    try {
      const offset = parseInt(req.query.offset as string, 10) || 0;
      const limit = parseInt(req.query.limit as string, 10) || 25;
      const provider = (req.query.provider as string) || null;
      const status = (req.query.status as string) || null;
      const q = (req.query.q as string) || null;
      const sort = (req.query.sort as string) || "session_last_message_at";
      const sortDir = (req.query.sort_dir as string) || "DESC";

      const storeInstance = getStore();

      let rows: any[];
      let total: number;

      if (q) {
        rows = storeInstance.searchSessions(q, {
          offset,
          limit,
          provider,
          status,
          sort,
          sortDir,
        });
        total = storeInstance.countSearch(q, provider, status);
      } else {
        rows = storeInstance.listSessions({
          offset,
          limit,
          provider,
          status,
          sort,
          sortDir,
        });
        total = storeInstance.countSessions(provider, status);
      }

      res.json({ sessions: rows, total, offset, limit });
    } catch (exc) {
      res
        .status(500)
        .json({ error: exc instanceof Error ? exc.message : String(exc) });
    }
  });

  // API: Get session detail
  app.get("/api/sessions/:sessionId", async (req: Request, res: Response) => {
    try {
      const row = await getStore().get(req.params.sessionId);
      if (!row) {
        return res.json({ error: "not found" });
      }
      res.json(row);
    } catch (exc) {
      res
        .status(500)
        .json({ error: exc instanceof Error ? exc.message : String(exc) });
    }
  });

  // API: Get session transcript
  app.get(
    "/api/sessions/:sessionId/transcript",
    async (req: Request, res: Response) => {
      try {
        const row = await getStore().get(req.params.sessionId);
        if (!row) {
          return res.json({ error: "not found" });
        }

        const messages = readTranscript(row.source_path, row.provider);
        res.json({ session_id: req.params.sessionId, messages });
      } catch (exc) {
        res
          .status(500)
          .json({ error: exc instanceof Error ? exc.message : String(exc) });
      }
    },
  );

  // API: Create share link for a session
  app.post(
    "/api/sessions/:sessionId/share",
    async (req: Request, res: Response) => {
      try {
        const { expiration_hours = 168 } = req.body || {};
        const result = getStore().createShareToken(
          req.params.sessionId,
          expiration_hours,
        );
        if (!result) {
          return res.status(404).json({ error: "Session not found" });
        }
        res.json({
          share_token: result.shareToken,
          share_url: `/shared/${result.shareToken}`,
          expires_at: result.expiresAt,
        });
      } catch (exc) {
        res
          .status(500)
          .json({ error: exc instanceof Error ? exc.message : String(exc) });
      }
    },
  );

  // API: Get shared session by token
  app.get("/api/shared/:token", async (req: Request, res: Response) => {
    try {
      const session = getStore().getSharedSession(req.params.token);
      if (!session) {
        return res
          .status(404)
          .json({ error: "Share link not found or expired" });
      }
      res.json(session);
    } catch (exc) {
      res
        .status(500)
        .json({ error: exc instanceof Error ? exc.message : String(exc) });
    }
  });

  // API: Get shared session transcript
  app.get(
    "/api/shared/:token/transcript",
    async (req: Request, res: Response) => {
      try {
        const session = getStore().getSharedSession(req.params.token);
        if (!session) {
          return res
            .status(404)
            .json({ error: "Share link not found or expired" });
        }
        const messages = readTranscript(session.source_path, session.provider);
        res.json({ session_id: session.id, messages });
      } catch (exc) {
        res
          .status(500)
          .json({ error: exc instanceof Error ? exc.message : String(exc) });
      }
    },
  );

  // Serve shared session UI
  app.get("/shared/:token", (req: Request, res: Response) => {
    try {
      // Cleanup expired shares
      getStore().cleanupExpiredShares();

      const session = getStore().getSharedSession(req.params.token);
      if (!session) {
        return res
          .status(404)
          .send(
            "<html><body><h1>Link not found or expired</h1></body></html>",
          );
      }

      const htmlPath = join(__dirname, "index.html");
      let html = readFileSync(htmlPath, "utf-8");
      // Inject share token for frontend
      html = html.replace(
        "<!-- SHARE_INJECTION_POINT -->",
        `<script>window.SHARE_TOKEN = "${req.params.token}";</script>`,
      );
      res.send(html);
    } catch (exc) {
      res
        .status(500)
        .send(
          exc instanceof Error ? exc.message : "Internal server error",
        );
    }
  });

  // ------------------------------------------------------------------
  // Pricing API
  // ------------------------------------------------------------------

  let pricingEngine: PricingEngine | null = null;

  function getPricing(): PricingEngine {
    if (!pricingEngine) {
      pricingEngine = new PricingEngine(dataDir);
    }
    return pricingEngine;
  }

  // API: List/search models with pricing info
  app.get("/api/pricing/models", async (req: Request, res: Response) => {
    try {
      const engine = getPricing();
      await engine.ensurePricingData();
      const q = (req.query.q as string) || "";
      const models = engine.searchModels(q);
      res.json({ models, total: models.length });
    } catch (exc) {
      res
        .status(500)
        .json({ error: exc instanceof Error ? exc.message : String(exc) });
    }
  });

  // API: Estimate cost for a model and token usage
  app.post("/api/pricing/estimate", async (req: Request, res: Response) => {
    try {
      const engine = getPricing();
      await engine.ensurePricingData();
      const {
        model,
        input_tokens = 0,
        output_tokens = 0,
        reasoning_tokens = 0,
        cached_input_tokens = 0,
        cache_creation_tokens = 0,
        cache_creation_1h_tokens = 0,
        input_convention = "includes_cache",
      } = req.body || {};
      if (!model) {
        return res.status(400).json({ error: "model is required" });
      }
      const breakdown = engine.estimateCost(
        model,
        Number(input_tokens),
        Number(output_tokens),
        Number(reasoning_tokens),
        Number(cached_input_tokens),
        Number(cache_creation_tokens),
        Number(cache_creation_1h_tokens),
        input_convention === "excludes_cache" ? "excludes_cache" : "includes_cache",
      );
      const modelInfo = engine.getModel(model);
      res.json({ ...breakdown, model_info: modelInfo });
    } catch (exc) {
      res
        .status(500)
        .json({ error: exc instanceof Error ? exc.message : String(exc) });
    }
  });

  app.post("/api/pricing/estimate-sessions", async (req: Request, res: Response) => {
    try {
      const engine = getPricing();
      await engine.ensurePricingData();
      const { models = [] } = req.body || {};
      if (!Array.isArray(models)) {
        return res.status(400).json({ error: "models must be an array" });
      }
      const requestModels = models.map((m: any) => ({
          model: m.model || "",
          input_tokens: Number(m.input_tokens) || 0,
          output_tokens: Number(m.output_tokens) || 0,
          reasoning_tokens: Number(m.reasoning_tokens) || 0,
          cached_input_tokens: Number(m.cached_input_tokens) || 0,
          cache_creation_tokens: Number(m.cache_creation_tokens) || 0,
          cache_creation_1h_tokens: Number(m.cache_creation_1h_tokens) || 0,
          input_convention:
            m.input_convention === "excludes_cache"
              ? ("excludes_cache" as const)
              : ("includes_cache" as const),
      }));
      const result = engine.estimateBatch(requestModels);
      const resultModels = result.models.map((entry, index) => ({
        ...entry,
        key: models[index]?.key || null,
      }));
      res.json({ ...result, models: resultModels });
    } catch (exc) {
      res
        .status(500)
        .json({ error: exc instanceof Error ? exc.message : String(exc) });
    }
  });

  // API: Log usage
  app.post("/api/pricing/usage", async (req: Request, res: Response) => {
    try {
      const engine = getPricing();
      const {
        model,
        input_tokens = 0,
        output_tokens = 0,
        reasoning_tokens = 0,
        cost = 0,
        label,
      } = req.body || {};
      if (!model) {
        return res.status(400).json({ error: "model is required" });
      }
      engine.logUsage(
        model,
        Number(input_tokens),
        Number(output_tokens),
        Number(reasoning_tokens),
        Number(cost),
        label,
      );
      res.json({ ok: true });
    } catch (exc) {
      res
        .status(500)
        .json({ error: exc instanceof Error ? exc.message : String(exc) });
    }
  });

  // API: Get usage history and stats
  app.get("/api/pricing/usage", (req: Request, res: Response) => {
    try {
      const engine = getPricing();
      const limit = parseInt(req.query.limit as string, 10) || 100;
      const history = engine.getUsageHistory(limit);
      const stats = engine.getUsageStats();
      res.json({ history, stats });
    } catch (exc) {
      res
        .status(500)
        .json({ error: exc instanceof Error ? exc.message : String(exc) });
    }
  });

  // API: Refresh pricing cache from GitHub
  app.post("/api/pricing/refresh", async (req: Request, res: Response) => {
    try {
      const engine = getPricing();
      const result = await engine.fetchAndCache();
      res.json({ ok: true, ...result });
    } catch (exc) {
      res
        .status(500)
        .json({ error: exc instanceof Error ? exc.message : String(exc) });
    }
  });

  // Error handler
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error(err.stack);
    res.status(500).json({ error: err.message });
  });

  // Start server
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`Rewind session viewer running at http://localhost:${port}`);
      console.log(`Serving UI at http://localhost:${port}/ui`);
      console.log(`Data directory: ${dataDir}`);
      resolve({ port: Number(port), close: () => server.close() });
    });
    server.on("error", (err: any) => {
      reject(err);
    });
  });
}

if (require.main === module) {
  startServer();
}
