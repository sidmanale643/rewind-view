/**
 * Rewind Web Server
 * Express server serving a single-page HTML interface for browsing
 * and searching sessions stored in the Rewind SQLite database.
 */

import express, { Request, Response, NextFunction } from "express";
import { join } from "path";
import { readFileSync, existsSync } from "fs";
import { networkInterfaces } from "os";
import { SessionStore } from "./services/sessionStore";
import { Indexer } from "./indexer";
import { PricingEngine } from "./pricing";
import { DEFAULT_DATA_DIR } from "./utils";
import { buildHandoffPacket, defaultHandoffDir, isHandoffTarget } from "./handoff";
import { readTranscript } from "./transcript";

function normalizeBaseUrl(url: string | null | undefined): string {
  return (url || "").replace(/\/+$/, "");
}

function firstHeaderValue(value: string | undefined): string | null {
  if (!value) return null;
  return value.split(",")[0].trim() || null;
}

function isLocalHost(host: string): boolean {
  const hostname = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : host.split(":")[0].toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

function firstLanIpv4(): string | null {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces || []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }
  return null;
}

export function startServer(options?: {
  port?: number | string;
  host?: string;
  dataDir?: string;
  publicUrl?: string;
}): Promise<{ port: number; close: () => void }> {
  const port = options?.port ?? process.env.PORT ?? 4820;
  const host = options?.host ?? process.env.HOST ?? "0.0.0.0";
  const dataDir = options?.dataDir ?? process.env.DATA_DIR ?? DEFAULT_DATA_DIR;
  const publicUrl = normalizeBaseUrl(options?.publicUrl ?? process.env.PUBLIC_URL);

  const app = express();
  app.set("trust proxy", true);

  let store: SessionStore | null = null;
  let reindexPromise: Promise<any> | null = null;

  function getStore(): SessionStore {
    if (!store) {
      store = new SessionStore(dataDir);
    }
    return store;
  }

  function getShareBaseUrl(req: Request): string {
    if (publicUrl) return publicUrl;

    const forwardedHost = firstHeaderValue(req.get("x-forwarded-host"));
    const forwardedProto = firstHeaderValue(req.get("x-forwarded-proto"));
    const hostHeader = forwardedHost || req.get("host") || "";
    const proto = forwardedProto || req.protocol || "http";

    if (hostHeader && isLocalHost(hostHeader)) {
      const lanIp = firstLanIpv4();
      if (lanIp) {
        const port = hostHeader.includes(":") ? hostHeader.split(":").pop() : "";
        return `${proto}://${lanIp}${port ? `:${port}` : ""}`;
      }
    }

    return hostHeader ? `${proto}://${hostHeader}` : "";
  }

  function renderIndexHtml(req: Request, shareToken?: string): string {
    const htmlPath = join(__dirname, "index.html");
    let html = readFileSync(htmlPath, "utf-8");
    const baseUrl = getShareBaseUrl(req);
    const script = [
      "<script>",
      shareToken ? `window.SHARE_TOKEN = ${JSON.stringify(shareToken)};` : "",
      baseUrl ? `window.PUBLIC_URL = ${JSON.stringify(baseUrl)};` : "",
      "</script>",
    ].join("");
    return html.replace("<!-- SHARE_INJECTION_POINT -->", script);
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
    res.send(renderIndexHtml(req));
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

  // API: Re-index every provider session, ignoring cached transcript hashes.
  app.post("/api/index/rebuild", async (req: Request, res: Response) => {
    if (reindexPromise) {
      return res.status(409).json({ error: "Reindex already in progress" });
    }

    const indexer = new Indexer(dataDir);
    const startedAt = new Date().toISOString();
    reindexPromise = indexer
      .indexAll({ force: true })
      .finally(() => {
        indexer.close();
        reindexPromise = null;
      });

    try {
      const results = await reindexPromise;
      const totals = results.reduce(
        (acc: any, result: any) => {
          acc.discovered += result.discovered || 0;
          acc.indexed += result.indexed || 0;
          acc.skipped += result.skipped || 0;
          acc.failed += result.failed || 0;
          return acc;
        },
        { discovered: 0, indexed: 0, skipped: 0, failed: 0 },
      );

      res.json({
        ok: totals.failed === 0,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        totals,
        results,
      });
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

  // API: Build a Markdown handoff packet
  app.post(
    "/api/sessions/:sessionId/handoff",
    async (req: Request, res: Response) => {
      try {
        const target = req.body?.target;
        if (!isHandoffTarget(target)) {
          return res.status(400).json({ error: "target must be claude or codex" });
        }

        const row = await getStore().get(req.params.sessionId);
        if (!row) {
          return res.status(404).json({ error: "Session not found" });
        }

        const messages =
          req.body?.messages === undefined
            ? undefined
            : Number(req.body.messages);
        res.json(
          buildHandoffPacket(row, {
            target,
            messages,
            handoffDir: defaultHandoffDir(target, row.id),
          }),
        );
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
        const baseUrl = getShareBaseUrl(req);
        res.json({
          share_token: result.shareToken,
          share_url: `/shared/${result.shareToken}`,
          share_full_url: baseUrl ? `${baseUrl}/shared/${result.shareToken}` : null,
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

      res.send(renderIndexHtml(req, req.params.token));
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
      res.json({
        status: history.length > 0 ? "ok" : "unavailable",
        history,
        stats,
      });
    } catch (exc) {
      res
        .status(500)
        .json({ error: exc instanceof Error ? exc.message : String(exc) });
    }
  });

  // API: Costs summary
  app.get("/api/pricing/costs", (req: Request, res: Response) => {
    try {
      const engine = getPricing();
      const summary = engine.getCostsSummary();
      res.json(summary);
    } catch (exc) {
      res.status(500).json({
        status: "unavailable",
        error: exc instanceof Error ? exc.message : String(exc),
      });
    }
  });

  // API: Cost estimates computed from indexed session data
  app.get("/api/costs/from-sessions", async (req: Request, res: Response) => {
    try {
      const engine = getPricing();
      await engine.ensurePricingData();
      const sessionCosts = getStore().getSessionCosts();

      const models = sessionCosts.map((sc) => {
        const convention =
          sc.provider === "claude" ? "excludes_cache" : "includes_cache";
        const breakdown = engine.estimateCost(
          sc.model,
          Number(sc.input_tokens) || 0,
          Number(sc.output_tokens) || 0,
          Number(sc.reasoning_tokens) || 0,
          Number(sc.cached_input_tokens) || 0,
          Number(sc.cache_creation_tokens) || 0,
          Number(sc.cache_creation_1h_tokens) || 0,
          convention,
        );
        const { model: _bm, ...breakdownFields } = breakdown;
        return {
          model: sc.model,
          provider: sc.provider,
          session_count: sc.session_count,
          ...breakdownFields,
        };
      });

      let totalCost = 0;
      let totalInput = 0;
      let totalOutput = 0;
      let totalCached = 0;
      let totalReasoning = 0;
      let totalTokens = 0;
      let totalSessions = 0;

      for (const m of models) {
        totalCost += m.total_cost;
        totalInput += m.input_tokens;
        totalOutput += m.output_tokens;
        totalCached += m.cached_input_tokens;
        totalReasoning += m.reasoning_tokens;
        totalTokens += m.input_tokens + m.output_tokens + m.reasoning_tokens;
        totalSessions += m.session_count;
      }

      res.json({
        status: models.length > 0 ? "ok" : "no-data",
        totalCost,
        totalInput,
        totalOutput,
        totalCached,
        totalReasoning,
        totalTokens,
        totalSessions,
        modelCount: models.length,
        models,
        pricingSource: "litellm",
        pricingUrl:
          "https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json",
      });
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
    const server = app.listen(Number(port), host, () => {
      console.log(`Rewind session viewer running at http://localhost:${port}`);
      console.log(`Serving UI at http://localhost:${port}/ui`);
      if (publicUrl) {
        console.log(`Public URL for sharing: ${publicUrl}`);
      }
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
