#!/bin/sh
# fragua one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/purrgrammer/fragua/main/install.sh | sh
#
# Detects your OS/arch, downloads the matching release binary (full flavor — web
# UI embedded), verifies it against the release SHA256SUMS, and drops it on your
# PATH. No build toolchain required; the binary is self-contained.
#
# Env overrides:
#   FRAGUA_VERSION=v0.9.0   install a specific tag (default: latest release)
#   FRAGUA_INSTALL_DIR=DIR  install location (default: $HOME/.local/bin)
#   FRAGUA_FLAVOR=headless  install the headless build (no web UI; what CI uses)
set -eu

REPO="purrgrammer/fragua"
FLAVOR="${FRAGUA_FLAVOR:-full}"
INSTALL_DIR="${FRAGUA_INSTALL_DIR:-$HOME/.local/bin}"

err() { printf 'fragua install: %s\n' "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# --- platform detection -----------------------------------------------------
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
  linux | darwin) ;;
  mingw* | msys* | cygwin* | windows*)
    err "no native Windows build — install under WSL2 and re-run this script there." ;;
  *) err "unsupported OS: $os (linux and darwin only)." ;;
esac

arch=$(uname -m | sed -e 's/x86_64/x64/' -e 's/aarch64/arm64/')
case "$arch" in
  x64 | arm64) ;;
  *) err "unsupported architecture: $arch (x64 and arm64 only)." ;;
esac

# Release asset naming: full is `fragua-bun-<os>-<arch>`, headless is
# `fragua-headless-bun-<os>-<arch>` (NOT a `-headless` suffix).
if [ "$FLAVOR" = "headless" ]; then
  asset="fragua-headless-bun-${os}-${arch}"
else
  asset="fragua-bun-${os}-${arch}"
fi

have curl || err "curl is required but not found on PATH."
# One of these is needed to verify the download checksum.
if have sha256sum; then sha_cmd="sha256sum"
elif have shasum; then sha_cmd="shasum -a 256"
else err "need sha256sum or shasum to verify the download."; fi

# --- resolve the release base URL -------------------------------------------
if [ -n "${FRAGUA_VERSION:-}" ]; then
  tag="$FRAGUA_VERSION"
  case "$tag" in v*) ;; *) tag="v$tag" ;; esac   # accept 0.9.0 or v0.9.0
  base="https://github.com/${REPO}/releases/download/${tag}"
  label="$tag"
else
  base="https://github.com/${REPO}/releases/latest/download"
  label="latest"
fi

# --- download + verify + install --------------------------------------------
tmp=$(mktemp -d 2>/dev/null || mktemp -d -t fragua)
trap 'rm -rf "$tmp"' EXIT INT TERM

printf 'fragua install: downloading %s (%s)…\n' "$asset" "$label" >&2
curl -fL --proto '=https' --tlsv1.2 -o "$tmp/fragua" "$base/$asset" \
  || err "download failed — is there a $FLAVOR release for ${os}-${arch}? (${base}/${asset})"

# Verify against SHA256SUMS. Match the asset as an exact awk field (SHA256SUMS
# is `<hash>  <name>`), avoiding grep-anchor/whitespace portability quirks.
if curl -fsL --proto '=https' -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"; then
  expected=$(awk -v a="$asset" '$2 == a { print $1; exit }' "$tmp/SHA256SUMS")
  [ -n "$expected" ] || err "no checksum for $asset in SHA256SUMS."
  actual=$($sha_cmd "$tmp/fragua" | awk '{ print $1 }')
  [ "$expected" = "$actual" ] || err "checksum mismatch for $asset (expected $expected, got $actual)."
  printf 'fragua install: checksum verified.\n' >&2
else
  err "could not fetch SHA256SUMS to verify the download."
fi

chmod +x "$tmp/fragua"
mkdir -p "$INSTALL_DIR"
mv "$tmp/fragua" "$INSTALL_DIR/fragua"
printf 'fragua install: installed to %s/fragua\n' "$INSTALL_DIR" >&2

# --- PATH check -------------------------------------------------------------
case ":$PATH:" in
  *":$INSTALL_DIR:"*) "$INSTALL_DIR/fragua" --version ;;
  *)
    printf 'fragua install: %s is not on your PATH.\n' "$INSTALL_DIR" >&2
    printf '  add it, e.g.:  export PATH="%s:$PATH"\n' "$INSTALL_DIR" >&2
    "$INSTALL_DIR/fragua" --version ;;
esac
