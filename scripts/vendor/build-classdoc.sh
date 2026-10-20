#!/bin/bash
# Rebuilds public/vendor/classdoc-editor.js from the exact versions in scripts/vendor/package.json (+ package-lock.json).
# Only needed when upgrading the editor; the app loads the committed file as-is (no build at deploy time).
set -e
cd "$(dirname "$0")"
npm ci --no-audit --no-fund --ignore-scripts
npx esbuild classdoc-editor.entry.mjs --bundle --format=esm --minify --target=es2020 --legal-comments=eof \
  --banner:js="/* TeroClass vendored editor: Yjs 13.6.32 + y-protocols 1.0.6 + y-prosemirror 1.3.7 + TipTap 2.27.2 (MIT). Built by scripts/vendor/build-classdoc.sh. Do not edit. */" \
  --outfile=../../public/vendor/classdoc-editor.js
rm -rf node_modules
