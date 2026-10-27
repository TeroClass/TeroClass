#!/bin/bash
# Rebuilds public/vendor/whiteboard/ (React 18.3.1 + ReactDOM 18.3.1 + @excalidraw/excalidraw 0.18.1, MIT) from the exact
# versions in scripts/vendor/whiteboard/package.json (+ package-lock.json). Only needed when upgrading; the app loads the
# committed files as-is (no build at deploy time). Details of what is kept / stubbed: scripts/vendor/whiteboard/build-whiteboard.mjs
set -e
cd "$(dirname "$0")/whiteboard"
npm ci --no-audit --no-fund --ignore-scripts
node build-whiteboard.mjs
rm -rf node_modules
du -sh ../../../public/vendor/whiteboard
