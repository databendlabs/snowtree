# Snowtree

Snowtree is Databend Labs' review-driven workflow for keeping AI coding sessions safe, auditable, and merge-ready.

AI generates code. You must review. You can't review everything or roll back safely.  
Snowtree fixes this with **worktree isolation**, **incremental review**, and **staging snapshots**.

![Snowtree Demo](assets/snowtree-show.gif)

## Highlights

- **Worktree isolation** – every AI session runs in its own Git worktree, so you can spike multiple ideas in parallel with zero merge headaches.
- **Incremental review loop** – review, stage, and lock in vetted changes after each AI round; subsequent rounds only diff against staged code.
- **Native CLI agents** – run Claude Code or Codex directly without wrappers, meaning no extra queues or limits.
- **Stage-as-snapshot** – staged files become the canonical baseline. When you're ready, merge them back and ship the PR.

## What Snowtree Automates

- **AI agent writes code** – edits live in the isolated worktree while you review.
- **AI agent commits** – generates messages and commits the staged snapshot.
- **AI agent syncs PRs** – opens or refreshes pull requests on demand.
- **AI agent updates from `main`** – rebases/merges the latest upstream changes.
- **AI agent resolves conflicts** – fixes merge conflicts without touching staged files.

## Prerequisites

Install at least one AI coding agent:

| Agent | Install |
|-------|---------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `npm install -g @anthropic-ai/claude-code` |
| [Codex](https://github.com/openai/codex) | `npm install -g @openai/codex` |

## Install

**One-line installer (macOS/Linux):**

```bash
curl -fsSL https://raw.githubusercontent.com/databendlabs/snowtree/main/install.sh | sh
```

**Manual download:** [GitHub Releases](https://github.com/databendlabs/snowtree/releases)

| Platform | Format |
|----------|--------|
| macOS | `.dmg` (arm64, x64) |
| Linux | `.deb`, `.AppImage` (x86_64) |

## Development

```bash
make install   # Install dependencies
make run       # Start development server
make check     # Typecheck, lint, and test
make build     # Build packages
```

## Remote Server Mode (LAN)

Snowtree can now run headlessly on a desktop/server and expose a web UI that phones/tablets can open over the local network.

1. Build the UI bundle once:
   ```bash
   corepack pnpm --filter @snowtree/ui build
   ```
2. Build the desktop package (this also emits the HTTP server entry):
   ```bash
   corepack pnpm --filter @snowtree/desktop build
   ```
3. Start the server, binding to the LAN interface you want to share (default host is `0.0.0.0`, default port is `8080`). Reusing Electron’s runtime avoids native module ABI mismatches:
   ```bash
   ELECTRON_RUN_AS_NODE=1 corepack pnpm exec electron packages/desktop/dist/server.js --host 0.0.0.0 --port 8080
   # Optional flags:
   #   --snowtree-dir /path/to/state  (override the Snowtree data directory)
   #   --ui-dist /path/to/ui/dist     (serve a custom UI build directory)
   #   --repo-root /path/to/repos     (expose git repositories under this directory for quick selection)
   ```
4. On any device that can reach the host machine, open `http://<host-ip>:8080`. The browser build auto-installs an `electronAPI` bridge that talks to the server over HTTP + SSE so the existing UI works without Electron.

Notes:
- File pickers are not available in web mode; when adding a project you will be prompted to type the repository path that exists on the server.
- The web client automatically targets the same origin, but you can point a custom build to another server by setting `VITE_REMOTE_API_URL` when running `pnpm --filter @snowtree/ui dev`/`build`.
- For convenience you can run `scripts/run-lan-server.sh --host 0.0.0.0 --port 8080` which performs the two builds and then starts the server (internally using `ELECTRON_RUN_AS_NODE=1 pnpm exec electron …`), forwarding any CLI flags you pass. Supplying `--repo-root` here lets the web UI show all git repos under that directory when you click “Add repository”.

## Learn More

[Snowtree: Review-Driven Safe AI Coding](https://www.bohutang.me/2026/01/10/snowtree-review-driven-safe-ai-coding/)

## License

Apache-2.0
