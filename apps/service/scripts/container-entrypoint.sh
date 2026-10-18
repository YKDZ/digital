#!/bin/sh
set -eu

: "${DIGITAL_PRODUCT_DATA:=/data}"
export DIGITAL_PRODUCT_DATA

case "${1:-prepare-and-start}" in
  prepare-only)
    cd /migration
    exec node ./dist/cli.js prepare-only
    ;;
  prepare-and-start)
    cd /migration
    node ./dist/cli.js prepare-only
    exec node /app/dist/main.js
    ;;
  *)
    echo "usage: container-entrypoint {prepare-only|prepare-and-start}" >&2
    exit 64
    ;;
esac
