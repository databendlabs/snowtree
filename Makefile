.DEFAULT_GOAL := help

.PHONY: help install run dev dev-ui dev-desktop clean-run
.PHONY: typecheck lint check test test-ui test-desktop
.PHONY: e2e e2e-electron build ci rebuild-electron

help:
	@echo "Snowtree (from source)"
	@echo ""
	@echo "Run:"
	@echo "  make install         Install dependencies"
	@echo "  make run             Start dev app (install + rebuild native deps + dev)"
	@echo "  make clean-run       Clean start (rm node_modules + run)"
	@echo "  make dev-ui          Start UI only (Vite)"
	@echo "  make dev-desktop     Watch-build desktop only (tsc -w)"
	@echo ""
	@echo "Test:"
	@echo "  make check           typecheck + lint + unit tests"
	@echo "  make test            Unit tests (UI + desktop)"
	@echo "  make e2e             Playwright E2E (browser)"
	@echo "  make e2e-electron    Playwright E2E (Electron; needs a display on Linux)"
	@echo ""
	@echo "Build:"
	@echo "  make build           Build all packages (core/desktop/ui)"
	@echo ""
	@echo "Troubleshooting:"
	@echo "  make rebuild-electron Rebuild native deps (e.g. better-sqlite3 ABI)"

install:
	pnpm install

typecheck:
	pnpm typecheck

lint:
	pnpm lint

check: typecheck lint test

run:
	pnpm install
	pnpm exec electron-builder install-app-deps
	pnpm dev

clean-run:
	rm -rf node_modules
	pnpm install
	pnpm exec electron-builder install-app-deps
	pnpm dev

dev: run

dev-ui:
	pnpm --filter @snowtree/ui dev

dev-desktop:
	pnpm --filter @snowtree/desktop dev

rebuild-electron:
	pnpm run electron:rebuild

test: test-ui test-desktop

test-ui:
	pnpm --filter @snowtree/ui test

test-desktop:
	pnpm --filter @snowtree/desktop test:ci

e2e:
	pnpm --filter @snowtree/ui test:e2e

e2e-electron:
	pnpm --filter @snowtree/ui test:e2e:electron

build:
	pnpm --filter @snowtree/core build
	pnpm --filter @snowtree/desktop build
	pnpm --filter @snowtree/ui build

ci: typecheck lint test e2e e2e-electron build
