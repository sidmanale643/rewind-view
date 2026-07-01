# AGENTS.md

## Quick commands

```bash
# Build and run the CLI
npm run build                    # Compile TypeScript to dist/
npm run rewind                   # Auto-index and start web UI

# Index sessions (idempotent)
rewind index
rewind index --rebuild        # Force re-index all sessions
rewind index --discover-only  # Record in SQLite only

# Search over indexed sessions
rewind search "OAuth login" --json
rewind search "react hooks" --provider claude -k 10

# Grep transcripts
rewind grep "useEffect" --context 3
rewind grep "error.*timeout" --provider codex

# Show session stats
rewind info

# Serve the web UI (auto-indexes)
rewind serve
# → http://localhost:4820/ui
```

## Architecture

**TypeScript/JavaScript project** with:

- **CLI entry point** (`src/cli.ts`) -- commands: index, search, grep, info, serve
- **Core indexer** (`src/indexer.ts`) -- orchestrates provider adapters, SQLite storage
- **Web server** (`src/server.ts`) -- Express serving HTML UI and REST APIs
- **Four provider adapters** in `src/connectors/`:
  - `claude.ts` - Claude Code `.jsonl` files
  - `codex.ts` - Codex `.jsonl` files + SQLite metadata
  - `antigravity.ts` - Google Gemini tool calls
  - `opencode.ts` - OpenCode SQLite database

**Data storage**:
- SQLite (`.rewind/data/rewind.sqlite`) -- session metadata and transcripts
- `data/rewind.sqlite` is the only persisted data

**Source locations**:
- Session discovery paths are embedded in each connector:
  - Claude: `~/.claude/projects/`
  - Codex: `~/.codex/sessions/`
  - OpenCode: `~/.local/share/opencode/opencode.db`
  - Antigravity: `~/.gemini/antigravity/brain/`

## Build and development

### Build
```bash
npm run build      # Compile TypeScript to dist/
npm run dev        # Watch mode for development
```

### Run tests (if any exist)
```bash
# The project has no configured tests
# Run manually if you add them to package.json
```

### Deploy with nginx (reverse proxy)
```bash
# Install nginx (macOS)
brew install nginx

# Copy config to nginx
cp nginx.conf /opt/homebrew/etc/nginx/nginx.conf

# Start/restart nginx
brew services restart nginx

# Start rewind server on port 3000
rewind serve --port 3000

# Access via nginx at http://localhost/
# Share links will use the nginx host automatically
```

## CLI usage patterns

### Indexing
- `--provider claude` restricts to Claude sessions only
- `--rebuild` forces re-indexing, ignoring content hash checks
- `--discover-only` skips embedding, only updates SQLite

### Searching
- `--provider <provider>` limits search to one source
- `--json` returns results as JSON for scripting

### Grep
- `--context <n>` controls number of context lines around matches
- `--limit <n>` caps maximum results

## Code conventions

- **TypeScript strict mode** with declaration files generated to `dist/`
- **Adapter pattern** for each provider (discover/parse)
- **Single-table SQLite** with FTS5 virtual table for full-text search
- **Idempotent indexing** by default via content hash comparison

## Important gotchas

1. **No test framework configured** -- add to package.json if you want tests
2. **Data directory default** is `~/.rewind/data/`
3. **Process management** -- the server uses Node.js, not standalone binary
4. **SQLite schema** -- uses WAL mode for concurrent access
5. **Resume commands** available in search results (`.resumeCommand` field)

## Key file locations

- `src/connectors/*.ts` - provider implementations
- `src/indexer.ts` - indexing orchestration
- `src/cli.ts` - command-line interface
- `src/server.ts` - web UI server
- `dist/index.html` - the web interface
- `package.json` - npm scripts and dependencies
- `tsconfig.json` - TypeScript configuration

## Next steps for agents

1. Run `npm run build` to see compiled output
2. Examine `src/connectors/claude.ts` to understand the parsing pattern
3. Check `src/services/sessionStore.ts` for SQLite interaction details
4. Look at `src/indexer.ts:256` to see adapter selection logic
5. The web UI is at `http://localhost:4820/ui` after `rewind serve`

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
