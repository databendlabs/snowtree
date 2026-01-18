#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[snowtree] Building web UI bundle..."
(cd "$ROOT_DIR" && corepack pnpm --filter @snowtree/core build)
(cd "$ROOT_DIR" && corepack pnpm --filter @snowtree/ui build)

echo "[snowtree] Building desktop/server bundle..."
(cd "$ROOT_DIR" && corepack pnpm --filter @snowtree/desktop build)

echo "[snowtree] Starting LAN server..."
cd "$ROOT_DIR"
export ELECTRON_RUN_AS_NODE=1
exec corepack pnpm exec electron packages/desktop/dist/server.js "$@"
