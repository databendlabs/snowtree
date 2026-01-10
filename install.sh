#!/bin/sh
set -eu

REPO="${SNOWTREE_REPO:-bohutang/snowtree}"
APP_NAME="${SNOWTREE_APP_NAME:-snowtree}"

info() { printf '%s\n' "[INFO] $*"; }
warn() { printf '%s\n' "[WARN] $*"; }
error() { printf '%s\n' "[ERROR] $*" >&2; exit 1; }

strip_v() {
  case "$1" in
    v*) printf '%s' "${1#v}" ;;
    *) printf '%s' "$1" ;;
  esac
}

fetch_latest_version() {
  if [ "${SNOWTREE_VERSION:-}" != "" ]; then
    VERSION="$SNOWTREE_VERSION"
    case "$VERSION" in
      v*) : ;;
      *) VERSION="v$VERSION" ;;
    esac
    return 0
  fi

  info "Fetching latest stable release..."
  RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")" || error "Failed to fetch release metadata"
  VERSION="$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  [ "$VERSION" != "" ] || error "Failed to parse latest version. Check https://github.com/$REPO/releases"
}

detect_platform() {
  OS="${SNOWTREE_OS:-$(uname -s)}"
  ARCH="${SNOWTREE_ARCH:-$(uname -m)}"

  case "$OS" in
    Darwin) PLATFORM="macos" ;;
    Linux) PLATFORM="linux" ;;
    *) error "Unsupported OS: $OS" ;;
  esac

  case "$PLATFORM" in
    macos)
      EXT="dmg"
      case "$ARCH" in
        arm64|aarch64) ARTIFACT_SUFFIX="macOS-arm64.dmg" ;;
        x86_64|amd64) ARTIFACT_SUFFIX="macOS-x64.dmg" ;;
        *) error "Unsupported macOS architecture: $ARCH" ;;
      esac
      ;;
    linux)
      if [ "${SNOWTREE_LINUX_PKG:-}" = "deb" ]; then
        EXT="deb"
        ARTIFACT_SUFFIX="linux-amd64.deb"
      elif [ "${SNOWTREE_LINUX_PKG:-}" = "appimage" ]; then
        EXT="AppImage"
        ARTIFACT_SUFFIX="linux-x86_64.AppImage"
      elif command -v dpkg >/dev/null 2>&1; then
        EXT="deb"
        ARTIFACT_SUFFIX="linux-amd64.deb"
      else
        EXT="AppImage"
        ARTIFACT_SUFFIX="linux-x86_64.AppImage"
      fi
      ;;
  esac

  info "Detected platform: $PLATFORM ($ARCH)"
}

download_and_install() {
  VERSION_NO_V="$(strip_v "$VERSION")"
  ARTIFACT_NAME="${APP_NAME}-${VERSION_NO_V}-${ARTIFACT_SUFFIX}"
  DOWNLOAD_URL="https://github.com/$REPO/releases/download/$VERSION/$ARTIFACT_NAME"

  if [ "${SNOWTREE_INSTALL_DRY_RUN:-}" = "1" ]; then
    info "Dry run: would download from: $DOWNLOAD_URL"
    return 0
  fi

  TEMP_DIR="$(mktemp -d)"
  DOWNLOAD_PATH="$TEMP_DIR/$ARTIFACT_NAME"

  info "Downloading from: $DOWNLOAD_URL"
  curl -fL --retry 3 --connect-timeout 15 -o "$DOWNLOAD_PATH" "$DOWNLOAD_URL" || error "Download failed (bad URL or network error)"

  case "$PLATFORM" in
    macos)
      MOUNT_POINT="$TEMP_DIR/mount"
      mkdir -p "$MOUNT_POINT"
      info "Mounting DMG..."
      hdiutil attach "$DOWNLOAD_PATH" -nobrowse -quiet -mountpoint "$MOUNT_POINT" || error "Failed to mount DMG"

      APP_SRC="$MOUNT_POINT/$APP_NAME.app"
      [ -d "$APP_SRC" ] || error "App bundle not found in DMG: $APP_SRC"

      APP_DST="/Applications/$APP_NAME.app"
      info "Installing to $APP_DST..."

      if [ -w "/Applications" ]; then
        rm -rf "$APP_DST" 2>/dev/null || true
        if command -v ditto >/dev/null 2>&1; then
          ditto "$APP_SRC" "$APP_DST"
        else
          cp -R "$APP_SRC" "$APP_DST"
        fi
      else
        warn "/Applications is not writable; attempting to use sudo"
        sudo rm -rf "$APP_DST" 2>/dev/null || true
        if command -v ditto >/dev/null 2>&1; then
          sudo ditto "$APP_SRC" "$APP_DST"
        else
          sudo cp -R "$APP_SRC" "$APP_DST"
        fi
      fi

      hdiutil detach "$MOUNT_POINT" -quiet || true
      info "Installed to $APP_DST"
      ;;
    linux)
      if [ "$EXT" = "deb" ]; then
        info "Installing .deb package..."
        sudo dpkg -i "$DOWNLOAD_PATH" || sudo apt-get install -f -y
      else
        info "Installing AppImage..."
        INSTALL_DIR="$HOME/.local/bin"
        mkdir -p "$INSTALL_DIR"
        mv "$DOWNLOAD_PATH" "$INSTALL_DIR/$APP_NAME"
        chmod +x "$INSTALL_DIR/$APP_NAME"
        info "Installed to $INSTALL_DIR/$APP_NAME"

        case ":${PATH}:" in
          *":$INSTALL_DIR:"*) : ;;
          *) warn "Add $INSTALL_DIR to your PATH: export PATH=\"\$PATH:$INSTALL_DIR\"" ;;
        esac
      fi
      ;;
  esac

  rm -rf "$TEMP_DIR"
  info "Installation complete! Run '$APP_NAME' to start."
}

main() {
  printf '\n'
  printf '%s\n' "  ╔═══════════════════════════════════════╗"
  printf '%s\n' "  ║       Snowtree Installer              ║"
  printf '%s\n' "  ╚═══════════════════════════════════════╝"
  printf '\n'

  fetch_latest_version
  info "Latest version: $VERSION"
  detect_platform
  download_and_install
}

main "$@"
