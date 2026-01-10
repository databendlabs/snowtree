#!/bin/sh
set -eu

fail() { printf '%s\n' "FAIL: $*" >&2; exit 1; }
assert_contains() {
  haystack="$1"
  needle="$2"
  printf '%s' "$haystack" | grep -F "$needle" >/dev/null 2>&1 || fail "Expected output to contain: $needle"
}

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

sh -n "$ROOT/install.sh"

out="$(SNOWTREE_INSTALL_DRY_RUN=1 SNOWTREE_VERSION=v9.9.9 SNOWTREE_OS=Darwin SNOWTREE_ARCH=arm64 sh "$ROOT/install.sh")"
assert_contains "$out" "Latest version: v9.9.9"
assert_contains "$out" "Detected platform: macos (arm64)"
assert_contains "$out" "Dry run: would download from: https://github.com/bohutang/snowtree/releases/download/v9.9.9/snowtree-9.9.9-macOS-arm64.dmg"

out="$(SNOWTREE_INSTALL_DRY_RUN=1 SNOWTREE_VERSION=9.9.9 SNOWTREE_OS=Darwin SNOWTREE_ARCH=x86_64 sh "$ROOT/install.sh")"
assert_contains "$out" "Latest version: v9.9.9"
assert_contains "$out" "Detected platform: macos (x86_64)"
assert_contains "$out" "Dry run: would download from: https://github.com/bohutang/snowtree/releases/download/v9.9.9/snowtree-9.9.9-macOS-x64.dmg"

out="$(SNOWTREE_INSTALL_DRY_RUN=1 SNOWTREE_VERSION=v9.9.9 SNOWTREE_OS=Linux SNOWTREE_ARCH=x86_64 SNOWTREE_LINUX_PKG=deb sh "$ROOT/install.sh")"
assert_contains "$out" "Detected platform: linux (x86_64)"
assert_contains "$out" "Dry run: would download from: https://github.com/bohutang/snowtree/releases/download/v9.9.9/snowtree-9.9.9-linux-amd64.deb"

out="$(SNOWTREE_INSTALL_DRY_RUN=1 SNOWTREE_VERSION=v9.9.9 SNOWTREE_OS=Linux SNOWTREE_ARCH=x86_64 SNOWTREE_LINUX_PKG=appimage sh "$ROOT/install.sh")"
assert_contains "$out" "Detected platform: linux (x86_64)"
assert_contains "$out" "Dry run: would download from: https://github.com/bohutang/snowtree/releases/download/v9.9.9/snowtree-9.9.9-linux-x86_64.AppImage"

printf '%s\n' "OK"

