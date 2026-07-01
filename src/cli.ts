#!/usr/bin/env node
/**
 * Rewind CLI
 * Console entry point for indexing, searching, and serving sessions.
 *
 * Usage:
 *     rewind                              # auto-index and print summary
 *     rewind index [--provider ...]       # explicit index
 *     rewind search "query" [--provider ...] [--k N]
 *     rewind grep "pattern" [--provider ...] [--context N]
 *     rewind info
 *     rewind serve [--port PORT]
 *     rewind doctor                       # verify environment
 */

import { Command } from "commander";
import { Provider } from "./models";
import { Indexer } from "./indexer";
import { SessionStore } from "./services/sessionStore";
import { DEFAULT_DATA_DIR, getDbPath } from "./utils";
import { buildHandoffPacket, defaultHandoffDir, isHandoffTarget } from "./handoff";
import chalk from "chalk";
import { readFileSync } from "fs";
import { join } from "path";

let debugMode = false;

function packageVersion(): string {
  try {
    const packageJsonPath = join(__dirname, "..", "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    return packageJson.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function handleError(err: any): never {
  if (debugMode) {
    console.error(err);
  } else {
    console.error(`error: ${err.message || err}`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("rewind")
  .description("Index and search assistant sessions via SQLite.")
  .version(packageVersion())
  .option("--debug", "Show full stack traces on error", false);

program.hook("preAction", (thisCommand) => {
  debugMode = program.opts().debug || false;
});

// ---------------------------------------------------------------------------
// Index command
// ---------------------------------------------------------------------------

program
  .command("index")
  .description("Discover and index sessions into a collection")
  .option(
    "--provider <provider>",
    "Which provider to index (default: all)",
    "all",
  )
  .option(
    "--rebuild",
    "Re-index every session, ignoring cached transcript hashes",
    false,
  )
  .option(
    "--discover-only",
    "Only discover and record sessions in SQLite, skip embedding/vector storage",
    false,
  )
  .option(
    "--data-dir <dir>",
    "Directory for persisted collections",
    DEFAULT_DATA_DIR,
  )
  .action(async (options: any) => {
    try {
      const indexer = new Indexer(options.dataDir);
      try {
        const force = options.rebuild;
        const discoverOnly = options.discoverOnly;

        let results;
        if (options.provider === "all") {
          results = await indexer.indexAll({ force, discoverOnly });
        } else {
          const provider =
            Provider[options.provider.toUpperCase() as keyof typeof Provider];
          if (!provider) {
            console.error(`error: unknown provider "${options.provider}"`);
            process.exit(1);
          }
          results = [
            await indexer.indexProvider(provider, { force, discoverOnly }),
          ];
        }

        console.log("index results:");
        for (const r of results) {
          console.log(
            `  ${r.provider.padEnd(8)} discovered=${r.discovered.toString().padStart(4)} ` +
              `indexed=${r.indexed.toString().padStart(4)} skipped=${r.skipped.toString().padStart(4)} ` +
              `failed=${r.failed.toString().padStart(4)} collection=${r.collection}`,
          );
          for (const err of r.errors.slice(0, 5)) {
            console.log(`      ! ${err}`);
          }
          if (r.errors.length > 5) {
            console.log(`      ! ... and ${r.errors.length - 5} more`);
          }
        }

        const allSuccess = results.every((r) => r.failed === 0);
        process.exit(allSuccess ? 0 : 1);
      } finally {
        indexer.close();
      }
    } catch (err: any) {
      handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// Search command
// ---------------------------------------------------------------------------

program
  .command("search")
  .description("Full-text search over indexed sessions")
  .argument("<query>", "Query text")
  .option("--provider <provider>", "Limit search to a single provider")
  .option("-k, --limit <n>", "Number of results to return (default: 5)", "5")
  .option(
    "--data-dir <dir>",
    "Directory for persisted collections",
    DEFAULT_DATA_DIR,
  )
  .option("--json", "Print results as JSON", false)
  .action(async (query: string, options: any) => {
    try {
      const indexer = new Indexer(options.dataDir);
      try {
        const provider = options.provider
          ? Provider[options.provider.toUpperCase() as keyof typeof Provider]
          : undefined;
        const k = parseInt(options.limit, 10);
        const hits = await indexer.search(query, provider, k);

        if (options.json) {
          console.log(JSON.stringify(hits, null, 2));
        } else {
          console.log(formatSearchHits(hits));
        }
        process.exit(0);
      } finally {
        indexer.close();
      }
    } catch (err: any) {
      handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// Grep command
// ---------------------------------------------------------------------------

program
  .command("grep")
  .description("Grep-style text search across session transcripts")
  .argument("<pattern>", "Regex pattern to search for in transcripts")
  .option("--provider <provider>", "Limit grep to a single provider")
  .option(
    "--context <n>",
    "Number of context lines around each match (default: 1)",
    "1",
  )
  .option(
    "--limit <n>",
    "Maximum number of sessions to return (default: 50)",
    "50",
  )
  .option(
    "--data-dir <dir>",
    "Directory for persisted collections",
    DEFAULT_DATA_DIR,
  )
  .option("--json", "Print results as JSON", false)
  .action(async (pattern: string, options: any) => {
    try {
      const indexer = new Indexer(options.dataDir);
      try {
        const provider = options.provider
          ? Provider[options.provider.toUpperCase() as keyof typeof Provider]
          : undefined;
        const contextLines = parseInt(options.context, 10);
        const limit = parseInt(options.limit, 10);
        const results = await indexer.grep(
          pattern,
          provider,
          contextLines,
          limit,
        );

        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          console.log(formatGrepResults(results));
        }
        process.exit(0);
      } finally {
        indexer.close();
      }
    } catch (err: any) {
      handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// Handoff command
// ---------------------------------------------------------------------------

program
  .command("handoff")
  .description("Create a handoff bundle for another assistant")
  .argument("<session-id>", "Rewind session id")
  .requiredOption("--to <target>", "Target assistant: claude or codex")
  .option(
    "--messages <n>",
    "Number of recent transcript messages to include, or 'all' (default: all, max: 100)",
    "all",
  )
  .option(
    "--data-dir <dir>",
    "Directory for persisted collections",
    DEFAULT_DATA_DIR,
  )
  .option(
    "--handoff-dir <dir>",
    "Directory for the handoff bundle",
  )
  .option(
    "--artifact-dir <dir>",
    "Legacy alias for --handoff-dir",
  )
  .option("--print", "Also print HANDOFF.md content to stdout", false)
  .option("--no-artifacts", "Do not write handoff bundle files")
  .action(async (sessionId: string, options: any) => {
    try {
      if (!isHandoffTarget(options.to)) {
        console.error("error: --to must be claude or codex");
        process.exit(1);
      }

      const store = new SessionStore(options.dataDir);
      try {
        const session = store.get(sessionId);
        if (!session) {
          console.error(`error: session not found: ${sessionId}`);
          process.exit(1);
        }

        const packet = buildHandoffPacket(session, {
          target: options.to,
          messages:
            String(options.messages).toLowerCase() === "all"
              ? undefined
              : Number(options.messages),
          handoffDir:
            options.artifacts === false
              ? null
              : options.handoffDir || options.artifactDir || defaultHandoffDir(options.to, sessionId),
        });
        if (options.print || options.artifacts === false) {
          console.log(packet.markdown);
        } else {
          console.log(`handoff: ${packet.handoff_path}`);
          console.log(`manifest: ${packet.manifest_path}`);
          console.log(`tool outputs: ${packet.output_artifacts?.length || 0}`);
        }
        process.exit(0);
      } finally {
        store.close();
      }
    } catch (err: any) {
      handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// Info command
// ---------------------------------------------------------------------------

program
  .command("info")
  .description("Show collection stats")
  .option(
    "--data-dir <dir>",
    "Directory for persisted collections",
    DEFAULT_DATA_DIR,
  )
  .action(async (options: any) => {
    try {
      const indexer = new Indexer(options.dataDir);
      try {
        const info = await indexer.info();
        console.log(JSON.stringify(info, null, 2));
        process.exit(0);
      } finally {
        indexer.close();
      }
    } catch (err: any) {
      handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// Serve command
// ---------------------------------------------------------------------------

program
  .command("serve")
  .description("Auto-index sessions and start the web UI at http://<host>:<port>/ui")
  .option("--port <port>", "Port to listen on", "4820")
  .option("--host <host>", "Host to bind to (use 0.0.0.0 for network access)", "0.0.0.0")
  .option(
    "--public-url <url>",
    "Public base URL for share links (e.g. http://192.168.1.5:4820)",
  )
  .option(
    "--data-dir <dir>",
    "Directory for persisted collections",
    DEFAULT_DATA_DIR,
  )
  .action(async (options: any) => {
    try {
      const bannerLines = [
        "  ██████╗ ███████╗██╗    ██╗██╗███╗   ██╗██████╗ ",
        "  ██╔══██╗██╔════╝██║    ██║██║████╗  ██║██╔══██╗",
        "  ██████╔╝█████╗  ██║ █╗ ██║██║██╔██╗ ██║██║  ██║",
        "  ██╔══██╗██╔══╝  ██║███╗██║██║██║╚██╗██║██║  ██║",
        "  ██║  ██║███████╗╚███╔███╔╝██║██║ ╚████║██████╔╝",
        "  ╚═╝  ╚═╝╚══════╝ ╚══╝╚══╝ ╚═╝╚═╝  ╚═══╝╚═════╝ ",
      ];
      const bannerPalette = [
        chalk.hex("#7ce3ea"),
        chalk.hex("#71dce6"),
        chalk.hex("#66d5e8"),
        chalk.hex("#5fcbef"),
        chalk.hex("#6bbdf7"),
        chalk.hex("#7ce3ea"),
      ];

      console.log("");
      bannerLines.forEach((line, index) => {
        console.log(bannerPalette[index](line));
      });
      console.log(chalk.hex("#9bb4bd")("  Session Viewer for AI Assistants"));
      console.log(chalk.hex("#4fd1c5")("  ●") + chalk.hex("#9bb4bd")(" Local index. Searchable timeline.\n"));

      const indexer = new Indexer(options.dataDir);
      try {
        const existingCount = indexer.sessionStore.countSessions();
        if (existingCount === 0) {
          console.log(chalk.yellow("  First run detected — indexing all sessions...\n"));
        } else {
          console.log(chalk.gray(`  Found ${existingCount} indexed sessions — checking for updates...\n`));
        }

        const results = await indexer.indexAll();
        const dbPath = getDbPath();

        let totalAdded = 0;
        let totalSkipped = 0;
        let totalFailed = 0;
        const failedFiles: string[] = [];

        for (const r of results) {
          totalAdded += r.indexed;
          totalSkipped += r.skipped;
          totalFailed += r.failed;
          for (const err of r.errors) {
            failedFiles.push(err);
          }
        }

        const totalNow = indexer.sessionStore.countSessions();

        console.log(chalk.green("  Indexing complete.\n"));
        console.log(`  Database:   ${dbPath}`);
        console.log(`  Sessions:   ${chalk.bold(String(totalNow))} total`);
        console.log(`  Indexed:    ${chalk.green(String(totalAdded))} new`);
        console.log(`  Skipped:    ${chalk.gray(String(totalSkipped))} unchanged`);
        if (totalFailed > 0) {
          console.log(`  Failed:     ${chalk.red(String(totalFailed))}`);
          for (const f of failedFiles.slice(0, 5)) {
            console.log(chalk.red(`    ! ${f}`));
          }
          if (failedFiles.length > 5) {
            console.log(chalk.red(`    ! ... and ${failedFiles.length - 5} more`));
          }
        }
        console.log("");

        const { startServer } = require("./server");
        const open = require("open");

        const port = parseInt(options.port, 10);
        await startServer({
          port,
          host: options.host,
          dataDir: options.dataDir,
          publicUrl: options.publicUrl,
        });

        setTimeout(() => {
          open(`http://localhost:${port}/ui`);
        }, 500);

        console.log(chalk.gray("\n  Press Ctrl+C to stop.\n"));
      } finally {
        // Note: do NOT close indexer here — server needs the DB
      }
    } catch (err: any) {
      handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// Doctor command
// ---------------------------------------------------------------------------

program
  .command("doctor")
  .description("Verify environment and database health")
  .action(async () => {
    const checks: { label: string; ok: boolean; detail: string }[] = [];

    // Node version
    const nodeVersion = process.version;
    const nodeMajor = parseInt(nodeVersion.slice(1), 10);
    checks.push({
      label: "Node version",
      ok: nodeMajor >= 18,
      detail: `${nodeVersion} (${nodeMajor >= 18 ? "OK" : "requires v18+"})`,
    });

    // Platform / arch
    checks.push({
      label: "Platform",
      ok: true,
      detail: `${process.platform} ${process.arch}`,
    });

    // better-sqlite3 loads
    let sqliteOk = false;
    try {
      const Database = require("better-sqlite3");
      const db = new Database(":memory:");
      db.exec("SELECT 1");
      db.close();
      sqliteOk = true;
    } catch (err: any) {
      checks.push({
        label: "better-sqlite3",
        ok: false,
        detail: `FAILED to load: ${err.message || err}`,
      });
    }
    if (sqliteOk) {
      checks.push({
        label: "better-sqlite3",
        ok: true,
        detail: "loaded OK",
      });
    }

    // Data directory writable
    const dataDir = DEFAULT_DATA_DIR;
    const dbPath = getDbPath();
    try {
      const { mkdirSync, accessSync, constants } = require("fs");
      mkdirSync(dataDir, { recursive: true });
      accessSync(dataDir, constants.W_OK);
      checks.push({
        label: "Data directory",
        ok: true,
        detail: dataDir,
      });
    } catch (err: any) {
      checks.push({
        label: "Data directory",
        ok: false,
        detail: `NOT writable: ${dataDir} — ${err.message}`,
      });
    }

    // DB file exists (only if previously initialized)
    try {
      const { existsSync } = require("fs");
      if (existsSync(dbPath)) {
        checks.push({
          label: "Database file",
          ok: true,
          detail: dbPath,
        });
      } else {
        checks.push({
          label: "Database file",
          ok: true,
          detail: `${dbPath} (will be created on first index)`,
        });
      }
    } catch {
      // unreachable
    }

    // Schema check (if DB exists)
    if (sqliteOk) {
      try {
        const Database = require("better-sqlite3");
        const { existsSync } = require("fs");
        if (existsSync(dbPath)) {
          const db = new Database(dbPath);
          const tables = db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
            )
            .all()
            .map((r: any) => r.name);
          db.close();
          const required = ["seen_sessions", "session_actions", "session_fts"];
          const missing = required.filter((t) => !tables.includes(t));
          if (missing.length === 0) {
            checks.push({
              label: "Schema",
              ok: true,
              detail: `tables: ${tables.join(", ")}`,
            });
          } else {
            checks.push({
              label: "Schema",
              ok: false,
              detail: `missing tables: ${missing.join(", ")}`,
            });
          }
        }
      } catch {
        // schema check is best-effort
      }
    }

    // Print results
    let allPassed = true;
    for (const c of checks) {
      const mark = c.ok ? "\u2714" : "\u2716";
      console.log(`  ${mark}  ${c.label.padEnd(20)} ${c.detail}`);
      if (!c.ok) allPassed = false;
    }

    console.log();
    if (allPassed) {
      console.log("All checks passed.");
    } else {
      console.log(
        "Some checks failed. Fix the issues above and re-run `rewind doctor`.",
      );
    }
    process.exit(allPassed ? 0 : 1);
  });

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatSearchHits(hits: any[]): string {
  if (!hits || hits.length === 0) return "no results";

  const lines: string[] = [];
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const title = hit.title || "(untitled)";
    const last = hit.lastMessageAt ? hit.lastMessageAt.substring(0, 19) : "";
    const cwd = hit.cwd || "-";
    const resume = hit.resumeCommand || "-";
    const snippet = (hit.snippet || "").replace(/\n/g, " ").trim();

    lines.push(
      `${(i + 1).toString().padStart(2)}. ${hit.id}\n` +
        `     score=${hit.score.toFixed(4)}  provider=${hit.provider}  last=${last}\n` +
        `     title: ${title}\n` +
        `     cwd:   ${cwd}\n` +
        `     resume: ${resume}`,
    );

    if (snippet) {
      lines.push(`     snippet: ${snippet}`);
    }
  }

  return lines.join("\n");
}

function formatGrepResults(results: any[]): string {
  if (!results || results.length === 0) return "no matches";

  const lines: string[] = [];

  for (const r of results) {
    const last = r.session_last_message_at
      ? r.session_last_message_at.substring(0, 19)
      : "";
    lines.push(
      `--- ${r.id} (${r.provider}) last=${last}\n    source: ${r.source_path}`,
    );

    for (const snippet of r.snippets || []) {
      lines.push(snippet);
    }

    lines.push("");
  }

  const totalMatches = results.reduce(
    (sum, r) => sum + (r.match_count || 0),
    0,
  );
  lines.push(`${results.length} session(s), ${totalMatches} matching line(s)`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0) {
  // Default to "serve" command
  process.argv.push("serve");
}

program.parse(process.argv);
