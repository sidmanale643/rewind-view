/**
 * Pricing engine — fetches model pricing from the same source as litellm.completion_cost().
 * Caches results in SQLite for fast lookups.
 */

import Database from "better-sqlite3";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

const PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type InputConvention = "includes_cache" | "excludes_cache";

export interface ModelPricing {
  model_name: string;
  provider: string;
  input_cost_per_token: number;
  output_cost_per_token: number;
  output_cost_per_reasoning_token: number;
  cache_read_input_token_cost: number;
  cache_creation_input_token_cost: number;
  cache_creation_input_token_cost_above_1hr: number;
  max_input_tokens: number;
  max_output_tokens: number;
  supports_reasoning: boolean;
  supports_vision: boolean;
  supports_function_calling: boolean;
  supports_prompt_caching: boolean;
  raw_json: string;
}

export interface CostBreakdown {
  model: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_input_tokens: number;
  cache_creation_tokens: number;
  cache_creation_1h_tokens: number;
  input_cost: number;
  output_cost: number;
  reasoning_cost: number;
  cache_read_cost: number;
  cache_creation_cost: number;
  cache_creation_1h_cost: number;
  total_cost: number;
}

export interface ModelSummary {
  model_name: string;
  provider: string;
  input_per_1m: number;
  output_per_1m: number;
  reasoning_per_1m: number;
  cache_read_per_1m: number;
  cache_creation_per_1m: number;
  cache_creation_above_1h_per_1m: number;
  supports_reasoning: boolean;
  max_input_tokens: number;
  max_output_tokens: number;
}

export class PricingEngine {
  private db: Database.Database;
  private warnings: string[] = [];
  private cacheStmts: {
    upsert: Database.Statement;
    getAll: Database.Statement;
    getOne: Database.Statement;
    getFetchedAt: Database.Statement;
  };

  constructor(dataDir: string) {
    const dbPath = join(dataDir, "rewind.sqlite");
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.ensureTables();
    this.migrateSchema();
    this.cacheStmts = this.prepareStatements();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pricing_cache (
        model_name TEXT PRIMARY KEY,
        provider TEXT,
        input_cost_per_token REAL DEFAULT 0,
        output_cost_per_token REAL DEFAULT 0,
        output_cost_per_reasoning_token REAL DEFAULT 0,
        cache_read_input_token_cost REAL DEFAULT 0,
        cache_creation_input_token_cost REAL DEFAULT 0,
        cache_creation_input_token_cost_above_1hr REAL DEFAULT 0,
        max_input_tokens INTEGER DEFAULT 0,
        max_output_tokens INTEGER DEFAULT 0,
        supports_reasoning INTEGER DEFAULT 0,
        supports_vision INTEGER DEFAULT 0,
        supports_function_calling INTEGER DEFAULT 0,
        supports_prompt_caching INTEGER DEFAULT 0,
        raw_json TEXT,
        fetched_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        label TEXT,
        logged_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_log_model ON usage_log(model);
      CREATE INDEX IF NOT EXISTS idx_usage_log_logged_at ON usage_log(logged_at);
    `);
  }

  private migrateSchema(): void {
    const expectedPricing: Array<{ name: string; def: string }> = [
      { name: "model_name", def: "TEXT PRIMARY KEY" },
      { name: "provider", def: "TEXT" },
      { name: "input_cost_per_token", def: "REAL DEFAULT 0" },
      { name: "output_cost_per_token", def: "REAL DEFAULT 0" },
      { name: "output_cost_per_reasoning_token", def: "REAL DEFAULT 0" },
      { name: "cache_read_input_token_cost", def: "REAL DEFAULT 0" },
      { name: "cache_creation_input_token_cost", def: "REAL DEFAULT 0" },
      { name: "cache_creation_input_token_cost_above_1hr", def: "REAL DEFAULT 0" },
      { name: "max_input_tokens", def: "INTEGER DEFAULT 0" },
      { name: "max_output_tokens", def: "INTEGER DEFAULT 0" },
      { name: "supports_reasoning", def: "INTEGER DEFAULT 0" },
      { name: "supports_vision", def: "INTEGER DEFAULT 0" },
      { name: "supports_function_calling", def: "INTEGER DEFAULT 0" },
      { name: "supports_prompt_caching", def: "INTEGER DEFAULT 0" },
      { name: "raw_json", def: "TEXT" },
      { name: "fetched_at", def: "INTEGER NOT NULL" },
    ];

    const expectedUsage: Array<{ name: string; def: string }> = [
      { name: "id", def: "INTEGER PRIMARY KEY AUTOINCREMENT" },
      { name: "model", def: "TEXT NOT NULL" },
      { name: "input_tokens", def: "INTEGER NOT NULL DEFAULT 0" },
      { name: "output_tokens", def: "INTEGER NOT NULL DEFAULT 0" },
      { name: "reasoning_tokens", def: "INTEGER NOT NULL DEFAULT 0" },
      { name: "cost", def: "REAL NOT NULL DEFAULT 0" },
      { name: "label", def: "TEXT" },
      { name: "logged_at", def: "INTEGER NOT NULL" },
    ];

    const migrateTable = (
      tableName: string,
      expected: Array<{ name: string; def: string }>,
    ) => {
      const existing = this.db
        .prepare(`PRAGMA table_info(${tableName})`)
        .all() as Array<{ name: string }>;
      const existingNames = new Set(existing.map((c) => c.name));

      for (const col of expected) {
        if (!existingNames.has(col.name)) {
          try {
            this.db.exec(
              `ALTER TABLE ${tableName} ADD COLUMN ${col.name} ${col.def}`,
            );
          } catch {
            // column already exists or table missing — skip
          }
        }
      }
    };

    migrateTable("pricing_cache", expectedPricing);
    migrateTable("usage_log", expectedUsage);
  }

  private prepareStatements() {
    return {
      upsert: this.db.prepare(`
        INSERT INTO pricing_cache (
          model_name, provider, input_cost_per_token, output_cost_per_token,
          output_cost_per_reasoning_token, cache_read_input_token_cost,
          cache_creation_input_token_cost, cache_creation_input_token_cost_above_1hr,
          max_input_tokens, max_output_tokens,
          supports_reasoning, supports_vision, supports_function_calling,
          supports_prompt_caching, raw_json, fetched_at
        ) VALUES (
          @model_name, @provider, @input_cost_per_token, @output_cost_per_token,
          @output_cost_per_reasoning_token, @cache_read_input_token_cost,
          @cache_creation_input_token_cost, @cache_creation_input_token_cost_above_1hr,
          @max_input_tokens, @max_output_tokens,
          @supports_reasoning, @supports_vision, @supports_function_calling,
          @supports_prompt_caching, @raw_json, @fetched_at
        )
        ON CONFLICT(model_name) DO UPDATE SET
          provider = excluded.provider,
          input_cost_per_token = excluded.input_cost_per_token,
          output_cost_per_token = excluded.output_cost_per_token,
          output_cost_per_reasoning_token = excluded.output_cost_per_reasoning_token,
          cache_read_input_token_cost = excluded.cache_read_input_token_cost,
          cache_creation_input_token_cost = excluded.cache_creation_input_token_cost,
          cache_creation_input_token_cost_above_1hr = excluded.cache_creation_input_token_cost_above_1hr,
          max_input_tokens = excluded.max_input_tokens,
          max_output_tokens = excluded.max_output_tokens,
          supports_reasoning = excluded.supports_reasoning,
          supports_vision = excluded.supports_vision,
          supports_function_calling = excluded.supports_function_calling,
          supports_prompt_caching = excluded.supports_prompt_caching,
          raw_json = excluded.raw_json,
          fetched_at = excluded.fetched_at
      `),
      getAll: this.db.prepare(
        "SELECT * FROM pricing_cache ORDER BY model_name",
      ),
      getOne: this.db.prepare(
        "SELECT * FROM pricing_cache WHERE model_name = :name",
      ),
      getFetchedAt: this.db.prepare(
        "SELECT fetched_at FROM pricing_cache ORDER BY fetched_at DESC LIMIT 1",
      ),
    };
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  /**
   * Ensure pricing data is loaded. Fetches from GitHub if cache is empty or stale.
   */
  async ensurePricingData(): Promise<void> {
    const row = this.cacheStmts.getFetchedAt.get() as
      | { fetched_at: number }
      | undefined;
    if (row && Date.now() - row.fetched_at < CACHE_TTL_MS) {
      return; // cache is fresh
    }
    await this.fetchAndCache();
  }

  /**
   * Fetch pricing data from GitHub and cache in SQLite.
   */
  async fetchAndCache(): Promise<{ modelsCached: number }> {
    const response = await fetch(PRICING_URL);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch pricing data: ${response.status} ${response.statusText}`,
      );
    }

    const data: Record<string, any> = await response.json() as any;
    const now = Date.now();
    let count = 0;
    this.warnings = [];

    const upsertMany = this.db.transaction((entries: [string, any][]) => {
      for (const [modelName, spec] of entries) {
        if (modelName === "sample_spec") continue;
        if (typeof spec !== "object" || spec === null) continue;

        const mode = spec.mode || "chat";
        if (mode !== "chat") continue; // only cache chat models

        const cacheReadRate = spec.cache_read_input_token_cost;
        const cacheCreateRate = spec.cache_creation_input_token_cost;
        const cacheCreate1hRate =
          spec.cache_creation_input_token_cost_above_1hr || 0;

        if (spec.supports_prompt_caching) {
          if (cacheReadRate == null || cacheReadRate === 0) {
            this.warnings.push(
              `${modelName}: supports_prompt_caching=true but cache_read_input_token_cost is missing or zero`,
            );
          }
          if (cacheCreateRate == null || cacheCreateRate === 0) {
            this.warnings.push(
              `${modelName}: supports_prompt_caching=true but cache_creation_input_token_cost is missing or zero`,
            );
          }
        }

        this.cacheStmts.upsert.run({
          model_name: modelName,
          provider: spec.litellm_provider || "unknown",
          input_cost_per_token: spec.input_cost_per_token || 0,
          output_cost_per_token: spec.output_cost_per_token || 0,
          output_cost_per_reasoning_token:
            spec.output_cost_per_reasoning_token || 0,
          cache_read_input_token_cost: cacheReadRate || 0,
          cache_creation_input_token_cost: cacheCreateRate || 0,
          cache_creation_input_token_cost_above_1hr: cacheCreate1hRate,
          max_input_tokens: spec.max_input_tokens || spec.max_tokens || 0,
          max_output_tokens: spec.max_output_tokens || spec.max_tokens || 0,
          supports_reasoning: spec.supports_reasoning ? 1 : 0,
          supports_vision: spec.supports_vision ? 1 : 0,
          supports_function_calling: spec.supports_function_calling ? 1 : 0,
          supports_prompt_caching: spec.supports_prompt_caching ? 1 : 0,
          raw_json: JSON.stringify(spec),
          fetched_at: now,
        });
        count++;
      }
    });

    upsertMany(Object.entries(data));
    return { modelsCached: count };
  }

  /**
   * Search models by name (fuzzy substring match).
   */
  searchModels(query: string = ""): ModelSummary[] {
    if (!query.trim()) {
      const rows = this.cacheStmts.getAll.all() as any[];
      return rows.map((r) => this.rowToSummary(r));
    }

    const pattern = `%${query.toLowerCase()}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM pricing_cache
         WHERE LOWER(model_name) LIKE :pattern
            OR LOWER(provider) LIKE :pattern
         ORDER BY
           CASE WHEN LOWER(model_name) LIKE :exact THEN 0 ELSE 1 END,
           model_name
         LIMIT 100`,
      )
      .all({ pattern, exact: `%${query.toLowerCase()}%` }) as any[];

    return rows.map((r) => this.rowToSummary(r));
  }

  /**
   * Get pricing for a specific model.
   */
  getModel(modelName: string): ModelPricing | null {
    const row = this.cacheStmts.getOne.get({ name: modelName }) as
      | any
      | undefined;
    if (!row) return null;
    return this.rowToPricing(row);
  }

  /**
   * Estimate cost for a given model and token usage.
   *
   * Provider conventions for `inputTokens` vs `cachedInputTokens`:
   *   - 'includes_cache' (default, OpenAI/Codex): inputTokens is the *total*
   *     input including any cached portion; non-cached = max(0, input - cached).
   *   - 'excludes_cache' (Anthropic): inputTokens is the *uncached* count
   *     only; cache fields are reported separately and must not be subtracted.
   *
   * `cacheCreationTokens` is the 5-minute cache-write bucket. The 1-hour
   * cache-write bucket goes to `cacheCreation1hTokens` (billed at the
   * `cache_creation_input_token_cost_above_1hr` rate, which is typically
   * several times the 5m rate). Anthropic reports the combined total as
   * `cache_creation_input_tokens` = 5m + 1h.
   */
  estimateCost(
    modelName: string,
    inputTokens: number,
    outputTokens: number,
    reasoningTokens: number = 0,
    cachedInputTokens: number = 0,
    cacheCreationTokens: number = 0,
    cacheCreation1hTokens: number = 0,
    inputConvention: InputConvention = "includes_cache",
  ): CostBreakdown {
    const model = this.getModel(modelName);
    if (!model) {
      return {
        model: modelName,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        reasoning_tokens: reasoningTokens,
        cached_input_tokens: cachedInputTokens,
        cache_creation_tokens: cacheCreationTokens,
        cache_creation_1h_tokens: cacheCreation1hTokens,
        input_cost: 0,
        output_cost: 0,
        reasoning_cost: 0,
        cache_read_cost: 0,
        cache_creation_cost: 0,
        cache_creation_1h_cost: 0,
        total_cost: 0,
      };
    }

    const nonCachedInput =
      inputConvention === "includes_cache"
        ? Math.max(0, inputTokens - cachedInputTokens)
        : inputTokens;
    const inputCost = nonCachedInput * model.input_cost_per_token;
    const outputCost = outputTokens * model.output_cost_per_token;
    const reasoningCost =
      reasoningTokens * model.output_cost_per_reasoning_token;
    const cacheReadCost = cachedInputTokens * model.cache_read_input_token_cost;
    const cacheCreationCost = cacheCreationTokens * model.cache_creation_input_token_cost;
    const cacheCreation1hCost =
      cacheCreation1hTokens * model.cache_creation_input_token_cost_above_1hr;

    return {
      model: modelName,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      reasoning_tokens: reasoningTokens,
      cached_input_tokens: cachedInputTokens,
      cache_creation_tokens: cacheCreationTokens,
      cache_creation_1h_tokens: cacheCreation1hTokens,
      input_cost: inputCost,
      output_cost: outputCost,
      reasoning_cost: reasoningCost,
      cache_read_cost: cacheReadCost,
      cache_creation_cost: cacheCreationCost,
      cache_creation_1h_cost: cacheCreation1hCost,
      total_cost:
        inputCost +
        outputCost +
        reasoningCost +
        cacheReadCost +
        cacheCreationCost +
        cacheCreation1hCost,
    };
  }

  estimateBatch(
    entries: Array<{
      model: string;
      input_tokens: number;
      output_tokens: number;
      reasoning_tokens?: number;
      cached_input_tokens?: number;
      cache_creation_tokens?: number;
      cache_creation_1h_tokens?: number;
      input_convention?: InputConvention;
    }>,
  ): {
    total_cost: number;
    models: Array<{
      model: string;
      input_tokens: number;
      output_tokens: number;
      reasoning_tokens: number;
      cached_input_tokens: number;
      cache_creation_tokens: number;
      cache_creation_1h_tokens: number;
      cost: number;
    }>;
  } {
    const models: Array<{
      model: string;
      input_tokens: number;
      output_tokens: number;
      reasoning_tokens: number;
      cached_input_tokens: number;
      cache_creation_tokens: number;
      cache_creation_1h_tokens: number;
      cost: number;
    }> = [];
    let totalCost = 0;

    for (const entry of entries) {
      const breakdown = this.estimateCost(
        entry.model,
        entry.input_tokens,
        entry.output_tokens,
        entry.reasoning_tokens || 0,
        entry.cached_input_tokens || 0,
        entry.cache_creation_tokens || 0,
        entry.cache_creation_1h_tokens || 0,
        entry.input_convention || "includes_cache",
      );
      models.push({
        model: entry.model,
        input_tokens: entry.input_tokens,
        output_tokens: entry.output_tokens,
        reasoning_tokens: entry.reasoning_tokens || 0,
        cached_input_tokens: entry.cached_input_tokens || 0,
        cache_creation_tokens: entry.cache_creation_tokens || 0,
        cache_creation_1h_tokens: entry.cache_creation_1h_tokens || 0,
        cost: breakdown.total_cost,
      });
      totalCost += breakdown.total_cost;
    }

    return { total_cost: totalCost, models };
  }

  /**
   * Log a usage entry.
   */
  logUsage(
    model: string,
    inputTokens: number,
    outputTokens: number,
    reasoningTokens: number,
    cost: number,
    label?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO usage_log (model, input_tokens, output_tokens, reasoning_tokens, cost, label, logged_at)
         VALUES (:model, :input_tokens, :output_tokens, :reasoning_tokens, :cost, :label, :logged_at)`,
      )
      .run({
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        reasoning_tokens: reasoningTokens,
        cost,
        label: label || null,
        logged_at: Date.now(),
      });
  }

  /**
   * Get usage history.
   */
  getUsageHistory(limit: number = 100): any[] {
    return this.db
      .prepare(
        `SELECT * FROM usage_log ORDER BY logged_at DESC LIMIT :limit`,
      )
      .all({ limit });
  }

  /**
   * Get aggregated usage stats.
   */
  getUsageStats(): {
    totalCost: number;
    total_cost: number;
    totalInputTokens: number;
    total_input_tokens: number;
    totalOutputTokens: number;
    total_output_tokens: number;
    totalReasoningTokens: number;
    total_reasoning_tokens: number;
    avgCostPerRequest: number;
    entryCount: number;
    byModel: Record<
      string,
      {
        cost: number;
        input_tokens: number;
        output_tokens: number;
        reasoning_tokens: number;
        requests: number;
      }
    >;
  } {
    const rows = this.db
      .prepare(
        `SELECT
           model,
           SUM(cost) as total_cost,
           SUM(input_tokens) as total_input_tokens,
           SUM(output_tokens) as total_output_tokens,
           SUM(reasoning_tokens) as total_reasoning_tokens,
           COUNT(*) as requests
         FROM usage_log
         GROUP BY model`,
      )
      .all() as any[];

    const byModel: Record<string, any> = {};
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalReasoningTokens = 0;
    let entryCount = 0;

    for (const row of rows) {
      byModel[row.model] = {
        cost: row.total_cost,
        input_tokens: row.total_input_tokens,
        output_tokens: row.total_output_tokens,
        reasoning_tokens: row.total_reasoning_tokens,
        requests: row.requests,
      };
      totalCost += row.total_cost;
      totalInputTokens += row.total_input_tokens;
      totalOutputTokens += row.total_output_tokens;
      totalReasoningTokens += row.total_reasoning_tokens;
      entryCount += row.requests;
    }

    return {
      totalCost,
      total_cost: totalCost,
      totalInputTokens,
      total_input_tokens: totalInputTokens,
      totalOutputTokens,
      total_output_tokens: totalOutputTokens,
      totalReasoningTokens,
      total_reasoning_tokens: totalReasoningTokens,
      avgCostPerRequest: entryCount > 0 ? totalCost / entryCount : 0,
      entryCount,
      byModel,
    };
  }

  getCostsSummary(): {
    status: "ok" | "unavailable";
    totalCost: number;
    total_cost: number;
    entryCount: number;
    avgCostPerRequest: number;
    byModel: Record<
      string,
      {
        cost: number;
        input_tokens: number;
        output_tokens: number;
        reasoning_tokens: number;
        requests: number;
        avg_cost_per_request: number;
      }
    >;
    dailyBreakdown: Array<{
      date: string;
      cost: number;
      entries: number;
    }>;
    last30DaysCost: number;
    pricingCacheStatus: "fresh" | "stale" | "empty";
    pricingCacheAge: number | null;
  } {
    const stats = this.getUsageStats();

    const cacheRow = this.cacheStmts.getFetchedAt.get() as
      | { fetched_at: number }
      | undefined;

    let pricingCacheStatus: "fresh" | "stale" | "empty" = "empty";
    let pricingCacheAge: number | null = null;
    if (cacheRow) {
      pricingCacheAge = Date.now() - cacheRow.fetched_at;
      pricingCacheStatus =
        pricingCacheAge < CACHE_TTL_MS ? "fresh" : "stale";
    }

    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const dailyRows = this.db
      .prepare(
        `SELECT
           DATE(logged_at / 1000, 'unixepoch', 'localtime') as date,
           SUM(cost) as cost,
           COUNT(*) as entries
         FROM usage_log
         WHERE logged_at >= :since
         GROUP BY date
         ORDER BY date ASC`,
      )
      .all({ since: thirtyDaysAgo }) as Array<{
      date: string;
      cost: number;
      entries: number;
    }>;

    let last30DaysCost = 0;
    for (const row of dailyRows) {
      last30DaysCost += row.cost;
    }

    const byModelWithAvg: Record<
      string,
      {
        cost: number;
        input_tokens: number;
        output_tokens: number;
        reasoning_tokens: number;
        requests: number;
        avg_cost_per_request: number;
      }
    > = {};

    for (const [model, data] of Object.entries(stats.byModel)) {
      byModelWithAvg[model] = {
        ...data,
        avg_cost_per_request:
          data.requests > 0 ? data.cost / data.requests : 0,
      };
    }

    return {
      status: stats.entryCount > 0 ? "ok" : "unavailable",
      totalCost: stats.totalCost,
      total_cost: stats.total_cost,
      entryCount: stats.entryCount,
      avgCostPerRequest: stats.avgCostPerRequest,
      byModel: byModelWithAvg,
      dailyBreakdown: dailyRows,
      last30DaysCost,
      pricingCacheStatus,
      pricingCacheAge,
    };
  }

  close(): void {
    this.db.close();
  }

  private rowToSummary(row: any): ModelSummary {
    return {
      model_name: row.model_name,
      provider: row.provider,
      input_per_1m: row.input_cost_per_token * 1_000_000,
      output_per_1m: row.output_cost_per_token * 1_000_000,
      reasoning_per_1m: row.output_cost_per_reasoning_token * 1_000_000,
      cache_read_per_1m: (row.cache_read_input_token_cost || 0) * 1_000_000,
      cache_creation_per_1m: (row.cache_creation_input_token_cost || 0) * 1_000_000,
      cache_creation_above_1h_per_1m:
        (row.cache_creation_input_token_cost_above_1hr || 0) * 1_000_000,
      supports_reasoning: row.supports_reasoning === 1,
      max_input_tokens: row.max_input_tokens,
      max_output_tokens: row.max_output_tokens,
    };
  }

  private rowToPricing(row: any): ModelPricing {
    return {
      model_name: row.model_name,
      provider: row.provider,
      input_cost_per_token: row.input_cost_per_token,
      output_cost_per_token: row.output_cost_per_token,
      output_cost_per_reasoning_token: row.output_cost_per_reasoning_token,
      cache_read_input_token_cost: row.cache_read_input_token_cost || 0,
      cache_creation_input_token_cost: row.cache_creation_input_token_cost || 0,
      cache_creation_input_token_cost_above_1hr:
        row.cache_creation_input_token_cost_above_1hr || 0,
      max_input_tokens: row.max_input_tokens,
      max_output_tokens: row.max_output_tokens,
      supports_reasoning: row.supports_reasoning === 1,
      supports_vision: row.supports_vision === 1,
      supports_function_calling: row.supports_function_calling === 1,
      supports_prompt_caching: row.supports_prompt_caching === 1,
      raw_json: row.raw_json,
    };
  }
}
