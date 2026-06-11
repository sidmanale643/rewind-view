/**
 * Standalone pricing-math verifier. Does not need a test framework.
 *
 *   npx tsx src/verify-pricing.ts
 *
 * Builds an in-memory PricingEngine, seeds a single Anthropic-style model
 * spec into the cache (bypassing the network), then asserts:
 *   1. OpenAI convention: inputTokens INCLUDES cached tokens -> non-cached = input - cached.
 *   2. Anthropic convention: inputTokens EXCLUDES cached tokens -> non-cached = input (no subtraction).
 *   3. 1-hour cache writes are billed at the above-1hr rate, not the 5m rate.
 *   4. Warnings are raised when supports_prompt_caching is true but rates are zero.
 *
 * Exits 0 on success, 1 on any failure.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";
import { PricingEngine } from "./pricing";

let failures = 0;

function assert(cond: boolean, label: string, detail: string = ""): void {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
    failures++;
  }
}

function approx(a: number, b: number, eps: number = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "rewind-verify-"));
  try {
    const engine = new PricingEngine(dir);

    // Seed one Anthropic spec (claude-3-5-haiku-20241022-shaped numbers)
    // from the LiteLLM model_prices_and_context_window.json published values.
    const db = new Database(join(dir, "rewind.sqlite"));
    db.prepare(`
      INSERT INTO pricing_cache (
        model_name, provider,
        input_cost_per_token, output_cost_per_token, output_cost_per_reasoning_token,
        cache_read_input_token_cost, cache_creation_input_token_cost,
        cache_creation_input_token_cost_above_1hr,
        max_input_tokens, max_output_tokens,
        supports_reasoning, supports_vision, supports_function_calling,
        supports_prompt_caching, raw_json, fetched_at
      ) VALUES (
        @m, 'anthropic',
        0.0000008, 0.000004, 0,
        0.00000008, 0.000001,
        0.000006,
        200000, 8192,
        0, 0, 0,
        1, '{}', @now
      )
    `).run({ m: "claude-3-5-haiku-20241022", now: Date.now() });
    db.close();

    // ------------------------------------------------------------------
    console.log("\n[1] OpenAI convention: inputTokens INCLUDES cached tokens");
    // 1,000 total input -> 800 are cache hits -> 200 non-cached.
    {
      const r = engine.estimateCost(
        "claude-3-5-haiku-20241022",
        1000,   // input (includes cache)
        500,    // output
        0,
        800,    // cached
        0, 0,
        "includes_cache",
      );
      const expectedInput = 200 * 0.0000008;       // 0.00016
      const expectedCacheRead = 800 * 0.00000008;  // 0.000064
      const expectedOutput = 500 * 0.000004;       // 0.002
      const expectedTotal = expectedInput + expectedCacheRead + expectedOutput;
      assert(r.input_cost === expectedInput, "input cost is non-cached * rate", `got ${r.input_cost}`);
      assert(r.cache_read_cost === expectedCacheRead, "cache read cost is cached * rate", `got ${r.cache_read_cost}`);
      assert(r.output_cost === expectedOutput, "output cost is output * rate", `got ${r.output_cost}`);
      assert(approx(r.total_cost, expectedTotal), "total = input + cache_read + output", `got ${r.total_cost} expected ${expectedTotal}`);
    }

    // ------------------------------------------------------------------
    console.log("\n[2] Anthropic convention: inputTokens EXCLUDES cached tokens");
    // Same physical call, but now inputTokens is the *uncached* count (200),
    // and the 800 cached tokens are reported separately. The 800 must NOT be
    // subtracted from input.
    {
      const r = engine.estimateCost(
        "claude-3-5-haiku-20241022",
        200,    // input (uncached only)
        500,
        0,
        800,    // cache hits
        0, 0,
        "excludes_cache",
      );
      const expectedInput = 200 * 0.0000008;       // 0.00016
      const expectedCacheRead = 800 * 0.00000008;  // 0.000064
      assert(r.input_cost === expectedInput, "input cost is full input * rate (not subtracted)", `got ${r.input_cost}`);
      assert(r.cache_read_cost === expectedCacheRead, "cache read cost is cached * rate", `got ${r.cache_read_cost}`);
      assert(r.input_cost > 0, "input cost is not clamped to 0 by the old subtraction bug");
    }

    // ------------------------------------------------------------------
    console.log("\n[3] 1-hour cache writes billed at above-1hr rate");
    // 100 5m cache writes + 50 1h cache writes.
    // 5m rate = 1e-6, 1h rate = 6e-6.
    {
      const r = engine.estimateCost(
        "claude-3-5-haiku-20241022",
        0, 0, 0, 0,
        100,    // 5m cache writes
        50,     // 1h cache writes
        "excludes_cache",
      );
      const expected5m = 100 * 0.000001;    // 0.0001
      const expected1h = 50 * 0.000006;     // 0.0003
      assert(r.cache_creation_cost === expected5m, "5m cache write cost", `got ${r.cache_creation_cost}`);
      assert(r.cache_creation_1h_cost === expected1h, "1h cache write cost", `got ${r.cache_creation_1h_cost}`);
      assert(r.cache_creation_1h_tokens === 50, "1h token count preserved");
      // The full total: 5m + 1h, plus everything else (zero here).
      assert(approx(r.total_cost, expected5m + expected1h), "total includes 1h bucket", `got ${r.total_cost}`);
    }

    // ------------------------------------------------------------------
    console.log("\n[4] Warnings raised for models with prompt caching but zero rates");
    {
      // Build a fresh engine dir so fetchAndCache() has something to populate.
      const dir2 = mkdtempSync(join(tmpdir(), "rewind-verify-warn-"));
      try {
        const eng2 = new PricingEngine(dir2);
        // Monkey-patch global fetch for this test.
        const fakeSpec = {
          "broken-model": {
            mode: "chat",
            litellm_provider: "anthropic",
            input_cost_per_token: 0.000001,
            output_cost_per_token: 0.000005,
            supports_prompt_caching: true,
            // cache_read_input_token_cost and cache_creation_input_token_cost deliberately missing
          },
        };
        const originalFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async () => ({
          ok: true,
          status: 200,
          json: async () => fakeSpec,
        });
        try {
          await eng2.fetchAndCache();
        } finally {
          (globalThis as any).fetch = originalFetch;
        }
        const warnings = eng2.getWarnings();
        const joined = warnings.join("\n");
        assert(
          warnings.length >= 2,
          "at least 2 warnings emitted for missing cache rates",
          `got ${warnings.length}: ${joined}`,
        );
        assert(
          joined.includes("broken-model") && joined.includes("cache_read_input_token_cost"),
          "warning mentions broken-model and cache_read",
          joined,
        );
        assert(
          joined.includes("cache_creation_input_token_cost"),
          "warning mentions cache_creation_input_token_cost",
          joined,
        );
        eng2.close();
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    }

    engine.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("");
  if (failures === 0) {
    console.log("all pricing checks passed");
    process.exit(0);
  } else {
    console.log(`${failures} pricing check(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("verify-pricing crashed:", err);
  process.exit(2);
});
