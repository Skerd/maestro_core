#!/bin/sh
# Rebuild @u4/opencv4nodejs native bindings against Homebrew OpenCV.
# The package's `build-opencv` CLI runs node-gyp from `cjs/` (missing binding.gyp),
# so we invoke node-gyp from the package root instead.
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/node_modules/@u4/opencv4nodejs"

if [ ! -d "$PKG" ]; then
  echo "error: @u4/opencv4nodejs not installed in $ROOT/node_modules" >&2
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "error: Homebrew required (brew install opencv)" >&2
  exit 1
fi

OPENCV_PREFIX="$(brew --prefix opencv 2>/dev/null || true)"
if [ -z "$OPENCV_PREFIX" ] || [ ! -d "$OPENCV_PREFIX" ]; then
  echo "error: OpenCV not found via Homebrew. Install with: brew install opencv" >&2
  exit 1
fi

export OPENCV4NODEJS_DISABLE_AUTOBUILD=1
export OPENCV_INCLUDE_DIR="${OPENCV_INCLUDE_DIR:-$OPENCV_PREFIX/include/opencv4}"
export OPENCV_LIB_DIR="${OPENCV_LIB_DIR:-$OPENCV_PREFIX/lib}"
export OPENCV_BIN_DIR="${OPENCV_BIN_DIR:-$OPENCV_PREFIX/bin}"

echo "Rebuilding @u4/opencv4nodejs against:"
echo "  INCLUDE=$OPENCV_INCLUDE_DIR"
echo "  LIB=$OPENCV_LIB_DIR"
echo "  BIN=$OPENCV_BIN_DIR"

cd "$PKG"
npx node-gyp rebuild --release --jobs max

NODE_BIN="$PKG/build/Release/opencv4nodejs.node"
if [ ! -f "$NODE_BIN" ]; then
  echo "error: rebuild finished but $NODE_BIN is missing" >&2
  exit 1
fi

cd "$ROOT"
node -e "require('@u4/opencv4nodejs'); console.log('opencv4nodejs OK:', require('@u4/opencv4nodejs').version || require('@u4/opencv4nodejs').default?.version || 'loaded')"
echo "Done."
