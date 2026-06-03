#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

MINIFY=""
if [[ "${1:-}" == "--minify" ]]; then
  MINIFY="--minify"
fi

build_variant() {  # $1 = __BUILD_READONLY__ flag, $2 = output file
  esbuild src/app.ts --bundle --format=iife --target=es2022 \
    --define:__BUILD_READONLY__="$1" $MINIFY --outfile=.bundle.js
  bun build-inline.ts "$2"
}

build_variant false rs-main.html   # local: read + write config.json
build_variant true  rs-web.html    # web server: read-only config.json

rm -f .bundle.js
