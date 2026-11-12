#!/usr/bin/env sh
# Installs Smart Model Router (smr) on macOS / Linux.
#   Inside a clone:  sh scripts/install.sh            (builds from source)
#   Anywhere:        sh install.sh [version]          (downloads a GitHub release; default: latest)
set -eu

REPO="i-smiling-buddha/smart-model-router-skill"
VERSION="${1:-latest}"
say() { printf '==> %s\n' "$1"; }
fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

say "Checking Node.js"
command -v node >/dev/null 2>&1 || fail "Node.js not found. Install Node 20+ (https://nodejs.org or your package manager)."
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 20 ] || fail "Node $(node -v) is too old; SMR needs Node 20+."

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(dirname "$SCRIPT_DIR")
if [ -f "$ROOT/scripts/build-release.mjs" ] && [ -d "$ROOT/packages/core" ]; then
  say "Building from source in $ROOT"
  (cd "$ROOT" && npm ci && npm run release:pack)
  PKG="$ROOT/release/smart-model-router-skill.tgz"
else
  if [ "$VERSION" = "latest" ]; then URL="https://github.com/$REPO/releases/latest/download/smart-model-router-skill.tgz"
  else URL="https://github.com/$REPO/releases/download/$VERSION/smart-model-router-skill.tgz"; fi
  TMP=$(mktemp -d)
  PKG="$TMP/smart-model-router-skill.tgz"
  say "Downloading $URL"
  curl -fsSL "$URL" -o "$PKG" || fail "download failed"
fi

say "Installing smr globally"
npm install -g "$PKG" || fail "npm install -g failed (on Linux you may need a user-level npm prefix: npm config set prefix ~/.npm-global)"

command -v smr >/dev/null 2>&1 || fail "smr installed to $(npm prefix -g)/bin, which is not on your PATH."
say "smr $(smr --version) installed"
smr doctor || true
printf '\nNext, inside your project:\n  smr init claude-code   # or opencode / codex\n  smr doctor\n'
