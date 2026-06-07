#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

MINIFY=""
if [[ "${1:-}" == "--minify" ]]; then
  MINIFY="--minify"
fi

esbuild src/app.ts --bundle --format=iife --target=es2022 $MINIFY --outfile=.bundle.js
bun build-inline.ts rs-web.html
rm -f .bundle.js
