# Snowtree

Snowtree is Databend Labs' review-driven workflow for keeping AI coding sessions safe, auditable, and merge-ready.

> 📦 **New home:** The project is moving from the personal `bohutang` org to [`databendlabs/snowtree`](https://github.com/databendlabs/snowtree). All new issues/releases will live there.

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

## Learn More

[Snowtree: Review-Driven Safe AI Coding](https://www.bohutang.me/2026/01/10/snowtree-review-driven-safe-ai-coding/)

## License

Apache-2.0
