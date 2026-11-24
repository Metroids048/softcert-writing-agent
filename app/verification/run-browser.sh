#!/bin/sh
set -eu
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
runtime=${SOFTCERT_RUNTIME:-"$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"}
exec "$runtime/node/bin/node" "$here/browser.mjs" "$@"
