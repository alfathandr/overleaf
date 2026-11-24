#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION="v24.22.3"
YARN_VERSION="4.18.0"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

NODE_INSTALL_DIR="${HOME}/.local/node-${NODE_VERSION}"
if [ ! -x "${NODE_INSTALL_DIR}/bin/node" ]; then
  mkdir -p "${HOME}/.local"
  TMP_TAR="$(mktemp /tmp/node.XXXXXX.tar.xz)"
  trap 'rm -f "$TMP_TAR"' EXIT
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o "$TMP_TAR"
  rm -rf "${NODE_INSTALL_DIR}.tmp"
  mkdir -p "${NODE_INSTALL_DIR}.tmp"
  tar -xJf "$TMP_TAR" -C "${NODE_INSTALL_DIR}.tmp" --strip-components=1
  rm -f "$TMP_TAR"
  trap - EXIT
  mv "${NODE_INSTALL_DIR}.tmp" "$NODE_INSTALL_DIR"
fi
ln -sfn "$NODE_INSTALL_DIR" "${HOME}/.local/node"

# Ensure non-interactive bash shells pick up Node.js and Corepack from ~/.bashrc
touch "${HOME}/.bashrc"
sed -i '/case \$- in/,/esac/d' "${HOME}/.bashrc" 2>/dev/null || true
grep -qxF 'export COREPACK_HOME="$HOME/.cache/corepack"' "${HOME}/.bashrc" || echo 'export COREPACK_HOME="$HOME/.cache/corepack"' >> "${HOME}/.bashrc"
grep -qxF 'export PATH="$HOME/.local/node/bin:$PATH"' "${HOME}/.bashrc" || echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> "${HOME}/.bashrc"

export COREPACK_HOME="${HOME}/.cache/corepack"
export PATH="${HOME}/.local/node/bin:${PATH}"

mkdir -p "$COREPACK_HOME"
corepack enable --install-directory "${HOME}/.local/node/bin"
if [ "$(yarn --version 2>/dev/null || true)" != "$YARN_VERSION" ]; then
  corepack prepare "yarn@${YARN_VERSION}" --activate
fi

# Track whether yarn.lock is clean before install; Overleaf CE prunes Pro workspaces on install
YARN_LOCK_CLEAN=0
if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git diff --quiet -- yarn.lock 2>/dev/null; then
  YARN_LOCK_CLEAN=1
fi

CYPRESS_INSTALL_BINARY=0 yarn install

if [ "$YARN_LOCK_CLEAN" -eq 1 ]; then
  git checkout -- yarn.lock 2>/dev/null || true
fi

# Pre-warm Maven dependencies for services/git-bridge when Maven is available
if command -v mvn >/dev/null 2>&1 && [ -f "services/git-bridge/pom.xml" ]; then
  mvn -B -q -f services/git-bridge/pom.xml test-compile
fi
