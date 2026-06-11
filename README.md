# Rewind

A standalone Node.js CLI and web UI for indexing and browsing AI assistant sessions from Claude, Codex, OpenCode, and Antigravity.

Sessions are indexed into `~/.rewind/data/rewind.sqlite` and then searchable from anywhere.

## Quick start

```bash
npx rewind-view
```

That's it. This will:
- Display a welcome banner
- Index all your AI sessions (first run) or check for updates (subsequent runs)
- Show a summary of what was indexed
- Open the web UI in your browser
- Stay running until you press Ctrl+C

Data is stored in `~/.rewind/data/` and persists across sessions.

---

## Installation

### npx (zero install)

```bash
npx rewind-view
```

### npm (global install)

```bash
npm install -g rewind-view
rewind
```

### From source

```bash
git clone <repo>
cd continuum-viewer
npm install
npm run build
rewind
```

---

## Commands

Running `rewind` with no arguments shows the banner, auto-indexes, and opens the web UI.

### `rewind index`

Explicitly discover and index sessions.

```bash
rewind index                          # index all providers
rewind index --provider claude        # claude only
rewind index --rebuild                # force re-index everything
rewind index --discover-only          # record in SQLite, skip indexing
rewind index --data-dir ./my-data     # custom data directory
```

Options:
| Flag | Default | Description |
|------|---------|-------------|
| `--provider` | `all` | `claude`, `codex`, `antigravity`, `opencode`, or `all` |
| `--rebuild` | false | Re-index every session ignoring cached hashes |
| `--discover-only` | false | Discover and record sessions without indexing |
| `--data-dir` | `~/.rewind/data` | Storage directory |

### `rewind serve`

Start the local web UI.

```bash
rewind serve                          # http://localhost:3000/ui
rewind serve --port 8080
rewind serve --data-dir ./my-data
```

### `rewind search`

Full-text search over indexed sessions.

```bash
rewind search "OAuth login"
rewind search "react hooks" --provider claude -k 10
rewind search "deploy" --json
```

### `rewind grep`

Regex grep across session transcripts with context lines.

```bash
rewind grep "useEffect"
rewind grep "error.*timeout" --context 3 --provider codex
```

### `rewind info`

Show indexed session counts and storage stats.

```bash
rewind info
```

---

## Session locations (auto-discovered)

| Provider | Default path |
|----------|-------------|
| Claude | `~/.claude/projects/` |
| Codex | `~/.codex/sessions/` |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| Antigravity | `~/.gemini/antigravity/brain/` |

---

## Data storage

All data is stored in `~/.rewind/data/rewind.sqlite` by default. Override with `--data-dir` on any command or set `DATA_DIR` / `PORT` environment variables for the server.

---

## License

MIT
