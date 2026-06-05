#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

MINIFY=""
if [[ "${1:-}" == "--minify" ]]; then
  MINIFY="--minify"
fi

build_variant() {  # $1 = __BUILD_READONLY__ flag, $2 = output file, $3.. = extra build-inline args
  esbuild src/app.ts --bundle --format=iife --target=es2022 \
    --define:__BUILD_READONLY__="$1" $MINIFY --outfile=.bundle.js
  bun build-inline.ts "$2" "${@:3}"
}

build_variant false rs-main.html                   # local: fetch + write config.json
build_variant true  rs-web.html --embed-config     # web server: self-contained, config.json embedded

rm -f .bundle.js
